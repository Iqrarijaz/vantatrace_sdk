import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';
import { VantaTraceOptions, VantaTraceContext, ErrorPayload } from './types';
import { normalizeError } from './normalizer';
import { getSystemContext, startTelemetrySampling } from './context';
import { sendPayload } from './transport';
import { createWinstonTransport } from './winston';
import { registerGlobalInstance } from './registry';
import { deepScrub, scrubString, ScrubOptions } from './scrub';

export class VantaTrace {
  private apiKey: string;
  private debug: boolean;
  private apiUrl: string;
  private scrubOptions: ScrubOptions;

  // native AsyncLocalStorage store to capture request context
  private static asyncLocalStorage = new AsyncLocalStorage<VantaTraceContext>();
  // Memory leak-proof duplicate filter
  private reportedErrors = new WeakSet<any>();
  // Reentrance guard: prevents infinite loops when SDK debug logging
  // triggers a monkey-patched logger, which would re-enter captureException.
  // Per-context via ALS when inside a request scope; global fallback for
  // uncaughtException / console.error calls outside any request.
  private _globalReentranceGuard = false;

  /** Check if an error capture is already in progress for this async context. */
  private _isCapturing(): boolean {
    const store = VantaTrace.asyncLocalStorage.getStore() as any;
    if (store) return !!store._vantaCapturing;
    return this._globalReentranceGuard;
  }

  /** Set/clear the capture-in-progress flag for the current async context. */
  private _setCapturing(value: boolean): void {
    const store = VantaTrace.asyncLocalStorage.getStore() as any;
    if (store) {
      store._vantaCapturing = value;
    } else {
      this._globalReentranceGuard = value;
    }
  }

  constructor(options: VantaTraceOptions) {
    this.apiKey = options.apiKey || '';
    this.debug = !!options.debug;

    // Default Ingestion Endpoint
    this.apiUrl = options.apiUrl || 'https://api.vantatrace.com/api/events';

    this.scrubOptions = {
      sensitiveKeys: options.sensitiveKeys,
      sensitivePatterns: options.sensitivePatterns
    };

    if (!options.apiKey && this.debug) {
      console.warn('[VantaTrace] WARNING: API key is missing. SDK will run in dry-run mode.');
    }

    if (this.debug) {
      console.log(`[VantaTrace] Initialized SDK.`);
    }

    // Start background system telemetry sampler (runs every 10 seconds, unrefed)
    startTelemetrySampling(10000);

    registerGlobalInstance(this, this.debug);
  }

  /**
   * Generate a lightweight hex trace ID for cross-cutting correlation.
   * Links Winston/Pino log entries with the same VantaTrace error event on the dashboard.
   */
  private _generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Get the trace ID associated with the current request context, if any.
   * Useful for linking custom Winston/Pino logger entries to VantaTrace error events.
   */
  public static getActiveTraceId(): string | undefined {
    const store = VantaTrace.asyncLocalStorage.getStore() as any;
    return store?.traceId;
  }

  /**
   * Primary method to capture exceptions and send them to VantaTrace
   */
  public captureException(error: any, context?: VantaTraceContext): void {
    if (this._isCapturing()) return;

    try {
      if (!this.apiKey) {
        if (this.debug) {
          console.log('[VantaTrace] Dry-run: captured exception:', error, 'Context:', context);
        }
        return;
      }

      // Deduplicate exceptions to prevent double reporting
      if (error && typeof error === 'object') {
        if (this.reportedErrors.has(error)) return;
        this.reportedErrors.add(error);
      }

      this._setCapturing(true);

      const normalized = normalizeError(error);
      const systemContext = getSystemContext();

      // Auto-extract request-level context from AsyncLocalStorage store
      const activeStore = VantaTrace.asyncLocalStorage.getStore() as any;
      
      // Retrieve or generate trace ID bound to this asynchronous context
      let traceId: string;
      if (activeStore) {
        if (!activeStore.traceId) {
          activeStore.traceId = this._generateTraceId();
        }
        traceId = activeStore.traceId;
      } else {
        traceId = this._generateTraceId();
      }

      const activeStoreCopy = activeStore || {};
      
      // Dynamically resolve properties from request reference if active
      let dynamicUserId: string | undefined = undefined;
      let dynamicRoute: string | undefined = undefined;
      if (activeStoreCopy.req) {
        const reqRef = activeStoreCopy.req;
        if (reqRef.user && typeof reqRef.user === 'object') {
          dynamicUserId = reqRef.user.id || reqRef.user._id || reqRef.user.userId;
        } else if (reqRef.userId) {
          dynamicUserId = reqRef.userId;
        }
        dynamicRoute = reqRef.route?.path || reqRef.path || reqRef.url;
      }

      const mergedContext: VantaTraceContext = {
        ...activeStoreCopy,
        userId: context?.userId || dynamicUserId || activeStoreCopy.userId,
        route: context?.route || dynamicRoute || activeStoreCopy.route,
        ...context,
        metadata: {
          ...activeStoreCopy.metadata,
          ...context?.metadata
        }
      };

      // Ensure req reference is removed from serialization scope
      delete (mergedContext as any).req;

      // Scrub PII/secrets before this payload ever leaves the process. Header
      // redaction happens earlier (requestHandler), but error message/stack
      // text, custom `extra` error properties, and metadata (which may include
      // request body/query captured in requestHandler, or arbitrary fields a
      // caller passed to captureException) can all carry embedded passwords,
      // tokens, or PII that a key-name check alone wouldn't catch.
      const scrubbedError = {
        ...normalized,
        message: scrubString(normalized.message, this.scrubOptions),
        stack: scrubString(normalized.stack, this.scrubOptions),
        extra: normalized.extra ? deepScrub(normalized.extra, this.scrubOptions) : normalized.extra,
        cause: normalized.cause?.map((c) => ({
          ...c,
          message: scrubString(c.message, this.scrubOptions),
          stack: scrubString(c.stack, this.scrubOptions)
        }))
      };
      const scrubbedContext: VantaTraceContext = {
        ...mergedContext,
        // route can be re-derived from the live `req` reference (dynamicRoute
        // above) after requestHandler already scrubbed its own copy — scrub
        // again here so a raw req.url/path with an embedded query string
        // (?password=...) can't bypass that via the dynamic-resolution path.
        route: mergedContext.route ? scrubString(mergedContext.route, this.scrubOptions) : mergedContext.route,
        metadata: mergedContext.metadata ? deepScrub(mergedContext.metadata, this.scrubOptions) : mergedContext.metadata
      };

      const payload: ErrorPayload = {
        apiKey: this.apiKey,
        timestamp: new Date().toISOString(),
        traceId,
        error: scrubbedError,
        context: scrubbedContext,
        system: systemContext,
        severity: mergedContext.severity || 'critical'
      };

      if (this.debug) {
        console.log(`[VantaTrace] [${traceId}] Sending error event: ${normalized.name} - ${normalized.message} (Severity: ${payload.severity || 'default'})`);
      }

      sendPayload(this.apiUrl, this.apiKey, payload, this.debug);
    } catch (e: any) {
      if (this.debug) {
        console.error(`[VantaTrace] Failed to capture exception internally: ${e.message}`);
      }
    } finally {
      this._setCapturing(false);
    }
  }

  /**
   * Helper method to capture critical errors
   */
  public captureCritical(error: any, context?: Omit<VantaTraceContext, 'severity'>): void {
    this.captureException(error, { ...context, severity: 'critical' });
  }

  /**
   * Helper method to capture warning errors
   */
  public captureWarning(error: any, context?: Omit<VantaTraceContext, 'severity'>): void {
    this.captureException(error, { ...context, severity: 'warning' });
  }

  /**
   * Helper method to capture info messages/errors
   */
  public captureInfo(error: any, context?: Omit<VantaTraceContext, 'severity'>): void {
    this.captureException(error, { ...context, severity: 'info' });
  }

  /**
   * Express Request Context middleware.
   * Mount at the very top of your Express app's middleware stack.
   * Seeds the AsyncLocalStorage scope with request details.
   */
  public requestHandler() {
    return (req: any, res: any, next: any) => {
      let userId = undefined;
      if (req.user && typeof req.user === 'object') {
        userId = req.user.id || req.user._id || req.user.userId;
      } else if (req.userId) {
        userId = req.userId;
      }

      // Deep-sanitize request body and query — recursively, not just a couple
      // of well-known top-level field names — since passwords/tokens/PII can
      // be nested (e.g. { user: { password: '...' } }) or under a field name
      // the SDK doesn't special-case.
      const sanitizedBody = req.body && typeof req.body === 'object'
        ? deepScrub(req.body, this.scrubOptions)
        : undefined;
      const sanitizedQuery = req.query && typeof req.query === 'object'
        ? deepScrub(req.query, this.scrubOptions)
        : undefined;

      // Extract client IP
      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress;

      // Extract and sanitize headers
      const sanitizedHeaders: Record<string, any> = {};
      const sensitiveHeaderKeys = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];
      const extraSensitiveKeys = (this.scrubOptions.sensitiveKeys || []).map((k) => k.toLowerCase());
      if (req.headers && typeof req.headers === 'object') {
        for (const [key, value] of Object.entries(req.headers)) {
          const lowerKey = key.toLowerCase();
          if (sensitiveHeaderKeys.includes(lowerKey) || extraSensitiveKeys.some((needle) => lowerKey.includes(needle))) {
            sanitizedHeaders[key] = '[REDACTED]';
          } else {
            sanitizedHeaders[key] = value;
          }
        }
      }

      // The raw request URL may itself carry a query string (?password=...) —
      // scrub it too rather than only the parsed req.query object.
      const sanitizedRoute = scrubString(req.route?.path || req.path || req.url || '', this.scrubOptions);

      const activeContext: any = {
        req, // Keep active request reference to dynamically resolve user/route parameters later
        userId: userId ? String(userId) : undefined,
        route: sanitizedRoute,
        method: req.method,
        ip: ip ? String(ip) : undefined,
        headers: sanitizedHeaders,
        metadata: {
          query: sanitizedQuery,
          body: sanitizedBody
        }
      };

      // Wrap route execution scope under AsyncLocalStorage context
      VantaTrace.asyncLocalStorage.run(activeContext, () => {
        next();
      });
    };
  }

  /**
   * Express Global Error Handling middleware.
   * Mount at the very bottom of your Express app's middleware stack.
   * Intercepts unhandled route exceptions and logs them under the active request scope.
   */
  public errorHandler() {
    return (err: any, req: any, res: any, next: any) => {
      this.captureException(err);
      next(err);
    };
  }

  /**
   * @deprecated Use requestHandler() at the top and errorHandler() at the bottom.
   */
  public expressMiddleware() {
    return this.errorHandler();
  }

  /**
   * Safe monkey-patching of console.error
   */
  private _patchConsole(): void {
    const originalConsoleError = console.error;
    const self = this;

    console.error = function (...args: any[]) {
      // Only CHECK the flag — do NOT set it here.
      // captureException sets/clears it internally. Setting it here would
      // cause captureException to see the flag and return early, silently
      // dropping the error.
      if (!self._isCapturing()) {
        const error = args.find(arg => arg instanceof Error);
        if (error) {
          try {
            self.captureException(error, {
              severity: 'critical',
              metadata: { source: 'Console Error Interception' }
            });
          } catch (err) {
            // Fail-silent
          }
        }
      }
      originalConsoleError.apply(console, args);
    };
  }

  /**
   * Safe conditional patching of Winston
   */
  private _tryPatchWinston(): void {
    try {
      const winston = require('winston');
      if (winston && winston.add) {
        const transport = createWinstonTransport(this);
        if (transport) {
          winston.add(transport);
          if (this.debug) {
            console.log('[VantaTrace Debug] Successfully auto-patched Winston logging.');
          }
        }
      }
    } catch (e) {
      // Winston is not present. Ignored.
    }
  }

  /**
   * Safe conditional patching of Pino
   */
  private _tryPatchPino(): void {
    try {
      const pino = require('pino');
      if (pino && pino.prototype && pino.prototype.write) {
        const originalWrite = pino.prototype.write;
        const self = this;

        pino.prototype.write = function (obj: any, msg: string, num: number) {
          // Only CHECK the flag — captureException manages it internally.
          if (!self._isCapturing()) {
            let err: any = null;
            if (obj && obj instanceof Error) {
              err = obj;
            } else if (obj && obj.err && obj.err instanceof Error) {
              err = obj.err;
            } else if (obj && obj.error && obj.error instanceof Error) {
              err = obj.error;
            }
            if (err) {
              try {
                self.captureException(err, {
                  severity: 'critical',
                  metadata: { source: 'Pino Logger Interception' }
                });
              } catch (e) {
                // Fail-silent
              }
            }
          }
          return originalWrite.call(this, obj, msg, num);
        };

        if (this.debug) {
          console.log('[VantaTrace Debug] Successfully auto-patched Pino logging.');
        }
      }
    } catch (e) {
      // Pino is not present. Ignored.
    }
  }

  /**
   * Centralized handler for all globally intercepted errors.
   *
   * Provides:
   * - Deduplication via reportedErrors WeakSet (errors reaching multiple handlers are sent once)
   * - ALS context extraction (request metadata survives even for catch-block re-throws)
   * - Strategy tagging (captureStrategy tells the dashboard HOW the error was caught)
   * - Cause chain correlation (dashboard links the secondary error to the original)
   * - Self-defense (SDK never crashes the host application)
   */
  private _handleCentralizedError(
    error: Error,
    strategyType: 'uncaughtException' | 'unhandledRejection' | 'consoleError' | 'winstonInterception' | 'pinoInterception'
  ): void {
    // Deduplication: errors may reach multiple handlers (e.g. console.error + uncaughtException)
    if (this.reportedErrors.has(error)) return;

    try {
      // Pull any surviving ALS context (route, userId, metadata) from the request that triggered the catch block
      const activeStore = VantaTrace.asyncLocalStorage.getStore() as any || {};

      this.captureException(error, {
        severity: 'critical',
        metadata: {
          ...activeStore.metadata,
          captureStrategy: strategyType,
          thrownFromCatchBlock: true,
          timestamp: new Date().toISOString()
        }
      });
    } catch (_internalErr) {
      // SDK self-defense: never crash the user's host app
    }
  }

  /**
   * Automatically catch all uncaught exceptions, unhandled rejections, and logger errors.
   *
   * This is the centralized safety net that intercepts:
   * 1. Synchronous uncaught exceptions (typos / runtime errors inside catch blocks)
   * 2. Unhandled async/await rejections (re-thrown errors inside async catch blocks)
   * 3. Errors flowing through monkey-patched loggers (console.error, Winston, Pino)
   */
  public initGlobalHandlers(): void {
    // ── Capture System 1: Synchronous Uncaught Exceptions ──
    // Catches native/runtime errors that escape catch blocks (e.g. typos, undefined refs)
    process.on('uncaughtException', (err) => {
      if (this.debug) {
        console.log('[VantaTrace] Captured uncaught exception globally');
      }
      this._handleCentralizedError(err, 'uncaughtException');

      // Allow time for the batched transport (setImmediate + DNS + TLS + 2s timeout)
      // to complete before the process dies.
      setTimeout(() => {
        process.exit(1);
      }, 1500);
    });

    // ── Capture System 2: Async/Await Catch-Block Re-throws ──
    // In modern Node.js, errors explicitly thrown or generated inside async catch blocks
    // surface as unhandled rejections. This captures them at the process root.
    process.on('unhandledRejection', (reason) => {
      if (this.debug) {
        console.log('[VantaTrace] Captured unhandled promise rejection globally');
      }
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this._handleCentralizedError(err, 'unhandledRejection');
    });

    // ── Capture System 3: Logger Monkey-Patch Interceptors ──
    this._patchConsole();
    this._tryPatchWinston();
    this._tryPatchPino();
  }
}
export default VantaTrace;
