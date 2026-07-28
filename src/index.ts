import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';
import { VantaTraceOptions, VantaTraceContext, ErrorPayload, Breadcrumb } from './types';
import { normalizeError } from './normalizer';
import { getSystemContext, startTelemetrySampling } from './context';
import { sendPayload } from './transport';
import { createWinstonTransport } from './winston';
import { registerGlobalInstance } from './registry';
import { startCaughtExceptionWatcher, CaughtExceptionInfo } from './caught-exceptions';


/** Cap on caught exceptions buffered per request while waiting for the response outcome. */
const MAX_BUFFERED_CAUGHT_ERRORS = 20;

export class VantaTrace {
  private apiKey: string;
  private debug: boolean;
  private apiUrl: string;
  private serviceName?: string;
  // Auto-capture configuration (resolved from options.autoCapture)
  private http5xxEnabled: boolean;
  private caughtReportPolicy: 'request-failure' | 'always';
  private stopCaughtWatcher: (() => void) | null = null;

  // native AsyncLocalStorage store to capture request context
  private static asyncLocalStorage = new AsyncLocalStorage<VantaTraceContext>();
  // Memory leak-proof duplicate filter
  private reportedErrors = new WeakSet<any>();
  // Reentrance guard: prevents infinite loops when SDK debug logging
  // triggers a monkey-patched logger, which would re-enter captureException.
  // Per-context via ALS when inside a request scope; global fallback for
  // uncaughtException / console.error calls outside any request.
  private _globalReentranceGuard = false;
  private _consoleGuard = false;


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
    this.serviceName = options.serviceName;

    // Default Ingestion Endpoint
    this.apiUrl = options.apiUrl || 'https://api.vantatrace.com/api/events';

    if (!options.apiKey && this.debug) {
      console.warn('[VantaTrace] WARNING: API key is missing. SDK will run in dry-run mode.');
    }

    // Resolve auto-capture configuration
    const autoCapture = options.autoCapture || {};
    this.http5xxEnabled = autoCapture.http5xx !== false;
    const caughtOpts = autoCapture.caughtExceptions;
    const caughtConfig = typeof caughtOpts === 'object' && caughtOpts !== null ? caughtOpts : {};
    this.caughtReportPolicy = caughtConfig.report || 'request-failure';

    if (caughtOpts) {
      if (process.env.NODE_ENV === 'production') {
        console.warn(
          '[VantaTrace] WARNING: Runtime caught-exception capture (V8 inspector watcher) is enabled in production. ' +
          'This is a high-risk operational choice that can block the event loop and cause latency spikes. ' +
          'Consider using compile-time AST instrumentation (@vantatrace/babel-plugin) instead.'
        );
      }
      this.stopCaughtWatcher = startCaughtExceptionWatcher(
        (error, info) => this._recordCaughtException(error, info),
        {
          includeNodeModules: !!caughtConfig.includeNodeModules,
          maxPerMinute: caughtConfig.maxPerMinute || 120,
          debug: this.debug
        }
      );
    }

    if (this.debug) {
      console.log(`[VantaTrace] Initialized SDK.`);
    }

    // Start background system telemetry sampler (runs every 10 seconds, unrefed)
    startTelemetrySampling(10000);

    // Initialize HTTP/HTTPS hooks for breadcrumbs
    this._patchHttp();

    registerGlobalInstance(this, this.debug);
  }

  /**
   * Stop background instrumentation (the V8 inspector watcher). Useful for
   * graceful shutdown and test teardown; safe to call multiple times.
   */
  public shutdown(): void {
    if (this.stopCaughtWatcher) {
      this.stopCaughtWatcher();
      this.stopCaughtWatcher = null;
    }
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

    // Mark the active request as "an error was reported" so the auto-capture
    // finalizer doesn't emit a duplicate/synthetic event for the same request.
    const requestStore = VantaTrace.asyncLocalStorage.getStore() as any;
    if (requestStore) requestStore._vantaErrorCaptured = true;

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

      if (activeStoreCopy.startTime && !mergedContext.duration) {
        mergedContext.duration = Date.now() - activeStoreCopy.startTime;
      }

      // Ensure req reference and SDK-internal bookkeeping are removed from serialization scope
      const breadcrumbs = mergedContext.breadcrumbs || [];
      delete (mergedContext as any).req;
      delete (mergedContext as any).startTime;
      delete (mergedContext as any)._vantaCapturing;
      delete (mergedContext as any)._vantaErrorCaptured;
      delete (mergedContext as any)._vantaCaughtErrors;
      delete (mergedContext as any)._vantaResponseBody;
      delete (mergedContext as any).breadcrumbs;

      const payload: ErrorPayload = {
        apiKey: this.apiKey,
        serviceName: this.serviceName,
        timestamp: new Date().toISOString(),
        traceId,
        error: normalized,
        context: mergedContext,
        system: systemContext,
        severity: mergedContext.severity || 'critical',
        breadcrumbs
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
      const startTime = Date.now();

      // Unified fallback chain regardless of whether req.user is present as
      // an object at all — req.userId is checked either way, not only when
      // req.user is missing/not-an-object.
      const rawUserId = (req.user && typeof req.user === 'object' ? (req.user.id || req.user._id || req.user.userId) : undefined) || req.userId;
      const userId: string | undefined = rawUserId ? String(rawUserId) : undefined;
      const userInfo: any =
        req.user && typeof req.user === 'object'
          ? {
              id: userId,
              email: req.user.email,
              role: req.user.role,
              tenantId: req.user.tenantId || req.user.tenant_id,
              orgId: req.user.orgId || req.user.organizationId || req.user.org_id
            }
          : userId
            ? { id: userId }
            : undefined;

      // MSISDN (phone number), from the first source that yields a
      // plausible-looking phone number: a dedicated header, then common
      // req.user field name variants. Normalized (non-digit/non-plus
      // characters stripped) and validated as phone-shaped (7-15 digits,
      // optional leading +, per the E.164 max length) before being accepted —
      // anything that doesn't look like a phone number is dropped rather than
      // forwarded as-is.
      const rawMsisdn =
        (typeof req.get === 'function' ? req.get('X-MSISDN') : undefined) ||
        req.headers?.['x-msisdn'] ||
        (req.user && typeof req.user === 'object'
          ? req.user.phone || req.user.mobilephone || req.user.mobilePhone || req.user.msisdn ||
            req.user.phoneNumber || req.user.mobileNumber
          : undefined);
      const msisdn: string | undefined = (() => {
        if (typeof rawMsisdn !== 'string' && typeof rawMsisdn !== 'number') return undefined;
        const cleaned = String(rawMsisdn).trim().replace(/[^\d+]/g, '');
        return /^\+?\d{7,15}$/.test(cleaned) ? cleaned : undefined;
      })();

      // Substrings that mark a key (request body/query field, or header name)
      // as sensitive — matched case-insensitively anywhere in the key, so e.g.
      // 'mpin'/'x-mpin' are covered by 'pin', 'authorization'/
      // 'proxy-authorization' by 'auth', 'set-cookie' by 'cookie', and
      // 'x-api-key' by 'api-key'. Shared by body, query, and header
      // sanitization below so a header carrying the same kind of value (an
      // MPIN, a token, ...) gets the same treatment as a body/query field.
      const SENSITIVE_KEY_SUBSTRINGS = ['password', 'token', 'secret', 'auth', 'pin', 'creditcard', 'cvv', 'cookie', 'api-key'];
      const isSensitiveKey = (key: string): boolean => {
        const lower = key.toLowerCase();
        return SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s));
      };

      // Redact sensitive-looking keys from a shallow object copy (request body,
      // query string params — anywhere user-supplied key/value pairs land).
      const redactSensitiveKeys = (obj: any): any => {
        if (!obj || typeof obj !== 'object') return obj;
        const copy = { ...obj };
        for (const key of Object.keys(copy)) {
          if (isSensitiveKey(key)) {
            copy[key] = '[REDACTED]';
          }
        }
        return copy;
      };

      const sanitizedBody: any = req.body && typeof req.body === 'object' ? redactSensitiveKeys(req.body) : undefined;
      const sanitizedQuery: any = req.query && typeof req.query === 'object' ? redactSensitiveKeys(req.query) : undefined;

      // Extract client IP & Geo headers
      const ip = req.ip || (req.headers && (req.headers['x-forwarded-for'] as string)) || req.socket?.remoteAddress;
      const geo = {
        ip: ip ? String(ip) : undefined,
        country: req.headers ? (req.headers['cf-ipcountry'] || req.headers['x-country'] || req.headers['x-geoip-country']) as string : undefined,
        region: req.headers ? (req.headers['x-region'] || req.headers['x-geoip-region']) as string : undefined,
        city: req.headers ? (req.headers['x-city'] || req.headers['x-geoip-city']) as string : undefined,
      };

      // Extract and sanitize headers — same substring check as body/query, so
      // an X-MPIN (or any other password/token/pin/cookie/api-key-shaped)
      // header is redacted before it ever leaves requestHandler(), independent
      // of the backend's own defense-in-depth scrubbing.
      const sanitizedHeaders: Record<string, any> = {};
      if (req.headers && typeof req.headers === 'object') {
        for (const [key, value] of Object.entries(req.headers)) {
          sanitizedHeaders[key] = isSensitiveKey(key) ? '[REDACTED]' : value;
        }
      }

      // App version, from the client's own reported version string — used to
      // spot version-specific regressions (e.g. "only v2.3.0 clients hit this").
      // No format validation beyond trimming/length-capping: unlike msisdn,
      // there's no single expected shape (semver, build numbers, etc. all vary).
      const rawAppVersion = (typeof req.get === 'function' ? req.get('X-APP-VERSION') : undefined) || req.headers?.['x-app-version'];
      const appVersion: string | undefined =
        typeof rawAppVersion === 'string' && rawAppVersion.trim() ? rawAppVersion.trim().slice(0, 64) : undefined;

      // Extract session ID and correlation ID
      const sessionId = req.sessionID || req.session?.id || req.headers?.['x-session-id'];
      const correlationId = req.headers?.['x-correlation-id'] || req.headers?.['x-request-id'] || req.headers?.['x-trace-id'];
      const featureFlags = req.featureFlags || req.flags || req.experiments;

      const activeContext: any = {
        req,
        userId: userId || undefined,
        user: userInfo,
        route: req.route?.path || req.path || req.url,
        method: req.method,
        ip: ip ? String(ip) : undefined,
        headers: sanitizedHeaders,
        body: sanitizedBody,
        query: sanitizedQuery,
        geo,
        sessionId: sessionId ? String(sessionId) : undefined,
        correlationId: correlationId ? String(correlationId) : undefined,
        featureFlags: featureFlags && typeof featureFlags === 'object' ? featureFlags : undefined,
        msisdn,
        appVersion,
        startTime,
        // Reserved for whatever a developer passes to captureException()'s own
        // `metadata` — auto-captured request data already has its own fields
        // above (body/query/etc.), so it isn't duplicated in here too.
        metadata: {},
        breadcrumbs: []
      };

      // Record the outgoing response body when the request ends up failing, so
      // a swallowed try/catch (no exception object, no autoCapture.caughtExceptions)
      // still surfaces *something* concrete about what went wrong — e.g. the
      // `{ error: 'Order failed' }` a catch block sent back to the client.
      // Whichever of res.json/res.send fires first wins; Express commonly calls
      // one through the other internally, so the second call is a no-op here.
      const recordResponseBody = (body: any) => {
        if (activeContext._vantaResponseBody === undefined) {
          activeContext._vantaResponseBody = body;
        }
      };
      if (res && typeof res.json === 'function') {
        const originalJson = res.json.bind(res);
        res.json = (body: any) => {
          try { recordResponseBody(body); } catch (_) {}
          return originalJson(body);
        };
      }
      if (res && typeof res.send === 'function') {
        const originalSend = res.send.bind(res);
        res.send = (body: any) => {
          try { recordResponseBody(body); } catch (_) {}
          return originalSend(body);
        };
      }

      // Auto-capture: once the response has been sent, report swallowed errors
      // for requests that failed with a 5xx status. 'finish' fires per response
      // and the listener holds only this request's context object.
      if (res && typeof res.on === 'function') {
        res.on('finish', () => this._onRequestFinished(activeContext, req, res));
      }

      // Wrap route execution scope under AsyncLocalStorage context
      VantaTrace.asyncLocalStorage.run(activeContext, () => {
        next();
      });
    };
  }

  /**
   * Records an exception observed at its throw site by the V8 inspector watcher
   * (see caught-exceptions.ts). Runs synchronously inside the throwing async
   * context, so the request's AsyncLocalStorage store is still active.
   */
  private _recordCaughtException(error: any, info: CaughtExceptionInfo): void {
    // Ignore exceptions raised by the SDK's own capture pipeline.
    if (this._isCapturing()) return;

    // Exceptions V8 predicts will escape every handler are already covered by
    // errorHandler()/uncaughtException with richer semantics — skip them here.
    if (info.uncaught) return;

    if (this.caughtReportPolicy === 'always') {
      this.captureException(error, {
        severity: 'warning',
        metadata: {
          captureStrategy: 'caughtException',
          handled: true,
          throwSite: info.frameUrl || undefined
        }
      });
      return;
    }

    // 'request-failure' policy: buffer on the active request and let the
    // response outcome decide (see _onRequestFinished). Outside a request
    // scope there is no outcome to correlate with, so the error is dropped.
    const store = VantaTrace.asyncLocalStorage.getStore() as any;
    if (!store) return;
    if (!store._vantaCaughtErrors) store._vantaCaughtErrors = [];
    if (store._vantaCaughtErrors.length < MAX_BUFFERED_CAUGHT_ERRORS) {
      store._vantaCaughtErrors.push(error);
    }
  }

  /**
   * Response finalizer for auto-capture. When a request ends with a 5xx status
   * and no exception was reported for it, this reports the real caught
   * exception (when the inspector watcher recorded one) or a synthetic
   * HttpServerError so the failure is at least visible on the dashboard.
   */
  private _onRequestFinished(store: any, req: any, res: any): void {
    try {
      const status = res?.statusCode;
      if (!status || status < 500) return;
      if (store._vantaErrorCaptured) return;

      // Re-enter the request's async context: 'finish' may be emitted from the
      // socket's context, and captureException reads ALS for enrichment.
      const capture = (error: any, context: VantaTraceContext) => {
        VantaTrace.asyncLocalStorage.run(store, () => this.captureException(error, context));
      };

      // The body actually sent back to the client — often the single most
      // concrete clue about what a swallowed catch block did, even when no
      // exception object was ever reported. Capped by the transport's own
      // payload size handling downstream; nothing extra to do here.
      const responseBody = store._vantaResponseBody;

      const caughtErrors: any[] = store._vantaCaughtErrors || [];
      if (caughtErrors.length > 0) {
        // The first caught exception is the root cause; later ones are usually
        // cascade failures. Summarize the rest instead of sending N events.
        const [primary, ...rest] = caughtErrors;
        capture(primary, {
          severity: 'critical',
          metadata: {
            captureStrategy: 'caughtException',
            handled: true,
            httpStatusCode: status,
            ...(responseBody !== undefined ? { responseBody } : {}),
            ...(rest.length > 0
              ? { additionalCaughtErrors: rest.map(e => `${e?.name || 'Error'}: ${e?.message || String(e)}`) }
              : {})
          }
        });
        return;
      }

      if (!this.http5xxEnabled) return;

      const method = req?.method || store.method || 'UNKNOWN';
      const route = store.route || req?.originalUrl || req?.url || 'unknown route';
      // Only nudge toward the caught-exception capture layers when they aren't
      // already active — no point telling someone to turn on a watcher that's
      // already running (it simply didn't observe a throw for this request,
      // e.g. because it originated inside node_modules).
      const hint = this.stopCaughtWatcher
        ? ''
        : ' Enable autoCapture.caughtExceptions (or use @vantatrace/sdk/babel-plugin) to capture the real error object automatically.';
      const synthetic = new Error(
        `${method} ${route} responded with HTTP ${status} but no exception was reported ` +
        `(likely swallowed by a try/catch block).${hint}`
      );
      synthetic.name = 'HttpServerError';
      capture(synthetic, {
        severity: 'critical',
        metadata: {
          captureStrategy: 'http5xx',
          handled: true,
          httpStatusCode: status,
          ...(responseBody !== undefined ? { responseBody } : {})
        }
      });
    } catch (_e) {
      // Never interfere with the response lifecycle.
    }
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
   * Safe monkey-patching of console logs to record breadcrumbs
   */
  private _patchConsole(): void {
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleInfo = console.info;
    const self = this;

    console.error = function (...args: any[]) {
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
        } else {
          try {
            self.addBreadcrumb({
              category: 'console',
              message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '),
              level: 'error',
              type: 'log'
            });
          } catch (_) {}
        }
      }
      originalConsoleError.apply(console, args);
    };

    console.log = function (...args: any[]) {
      if (!self._consoleGuard) {
        self._consoleGuard = true;
        try {
          self.addBreadcrumb({
            category: 'console',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '),
            level: 'info',
            type: 'log'
          });
        } catch (_) {}
        self._consoleGuard = false;
      }
      originalConsoleLog.apply(console, args);
    };

    console.warn = function (...args: any[]) {
      if (!self._consoleGuard) {
        self._consoleGuard = true;
        try {
          self.addBreadcrumb({
            category: 'console',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '),
            level: 'warning',
            type: 'log'
          });
        } catch (_) {}
        self._consoleGuard = false;
      }
      originalConsoleWarn.apply(console, args);
    };

    console.info = function (...args: any[]) {
      if (!self._consoleGuard) {
        self._consoleGuard = true;
        try {
          self.addBreadcrumb({
            category: 'console',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '),
            level: 'info',
            type: 'log'
          });
        } catch (_) {}
        self._consoleGuard = false;
      }
      originalConsoleInfo.apply(console, args);
    };
  }

  /**
   * Public helper to record manual breadcrumbs
   */
  public addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'timestamp'>): void {
    try {
      const store = VantaTrace.asyncLocalStorage.getStore() as any;
      if (store) {
        if (!store.breadcrumbs) store.breadcrumbs = [];
        if (store.breadcrumbs.length >= 50) {
          store.breadcrumbs.shift();
        }
        store.breadcrumbs.push({
          ...breadcrumb,
          timestamp: new Date().toISOString()
        });
      }
    } catch (_) {}
  }

  /**
   * Safe monkey-patching of outbound HTTP and HTTPS requests to log network breadcrumbs
   */
  private _patchHttp(): void {
    const self = this;
    try {
      const http = require('http');
      const https = require('https');

      const patchRequest = (module: any, isHttps: boolean) => {
        if (!module || !module.request) return;
        const originalRequest = module.request;

        module.request = function (options: any, ...args: any[]) {
          try {
            let urlStr = '';
            let host = '';
            if (typeof options === 'string') {
              urlStr = options;
              const parsed = new URL(options);
              host = parsed.host;
            } else if (options && typeof options === 'object') {
              host = options.hostname || options.host || 'localhost';
              const protocol = options.protocol || (isHttps ? 'https:' : 'http:');
              const path = options.path || '/';
              urlStr = `${protocol}//${host}${path}`;
            }

            // Exclude self-telemetry calls
            const selfUrl = new URL(self.apiUrl);
            if (host && selfUrl.host && host.toLowerCase() === selfUrl.host.toLowerCase()) {
              return originalRequest.apply(this, [options, ...args]);
            }

            if (urlStr) {
              const method = (options && options.method) || 'GET';
              self.addBreadcrumb({
                category: 'http',
                message: `${method} ${urlStr}`,
                level: 'info',
                type: 'http',
                data: { method, url: urlStr }
              });
            }
          } catch (_) {}
          return originalRequest.apply(this, [options, ...args]);
        };
      };

      patchRequest(http, false);
      patchRequest(https, true);
    } catch (_) {}
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
