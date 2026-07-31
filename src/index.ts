import * as crypto from 'crypto';
import { VantaTraceOptions, VantaTraceContext, ErrorPayload, Breadcrumb, Span, SpanType } from './types';
import { normalizeError } from './normalizer';
import { getSystemContext, startTelemetrySampling } from './context';
import { sendPayload, getTransportDropStats, resetTransportDropStats } from './transport';
import { createWinstonTransport } from './winston';
import { registerGlobalInstance } from './registry';
import { startCaughtExceptionWatcher, CaughtExceptionInfo } from './caught-exceptions';
import { tryPatchPg, tryPatchMysql2, tryPatchIoredis } from './instrumentation';
import { createMasker } from './masking';
import { createRateLimiter, RateLimiter } from './rateLimiter';
import { dynamicRequire } from './nodeRequire';
import { requestStorage } from './store';
import { patchConsole } from './consoleInstrumentation';
import { patchHttp } from './httpInstrumentation';
import { tryPatchPino } from './pino';
import { finishAutoCapture } from './autoCaptureFinisher';
import { buildRequestContext } from './requestContext';


/** Cap on caught exceptions buffered per request while waiting for the response outcome. */
const MAX_BUFFERED_CAUGHT_ERRORS = 20;
/** Cap on spans (HTTP/DB/Redis sub-calls) recorded per request — oldest is dropped once exceeded. */
const MAX_SPANS_PER_REQUEST = 100;

export class VantaTrace {
  private apiKey: string;
  private debug: boolean;
  private apiUrl: string;
  // Auto-capture configuration (resolved from options.autoCapture)
  private http5xxEnabled: boolean;
  private http4xxEnabled: boolean;
  private http4xxExclude: Set<number>;
  private caughtReportPolicy: 'request-failure' | 'always';
  private stopCaughtWatcher: (() => void) | null = null;
  private masker: (value: any) => any;
  private rateLimiter: RateLimiter;
  private dropReportInterval: NodeJS.Timeout | null = null;

  // Memory leak-proof duplicate filter
  private reportedErrors = new WeakSet<any>();
  // Reentrance guard: prevents infinite loops when SDK debug logging
  // triggers a monkey-patched logger, which would re-enter captureException.
  // Per-context via ALS when inside a request scope; global fallback for
  // uncaughtException / console.error calls outside any request.
  private _globalReentranceGuard = false;


  /** Check if an error capture is already in progress for this async context. */
  private _isCapturing(): boolean {
    const store = requestStorage.getStore() as any;
    if (store) return !!store._vantaCapturing;
    return this._globalReentranceGuard;
  }

  /** Set/clear the capture-in-progress flag for the current async context. */
  private _setCapturing(value: boolean): void {
    const store = requestStorage.getStore() as any;
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
    this.masker = createMasker(options.maskingKeys || []);
    this.rateLimiter = createRateLimiter(options.rateLimit || {});

    if (!options.apiKey && this.debug) {
      console.warn('[VantaTrace] WARNING: API key is missing. SDK will run in dry-run mode.');
    }

    // Resolve auto-capture configuration
    const autoCapture = options.autoCapture || {};
    this.http5xxEnabled = autoCapture.http5xx !== false;
    const clientErrorOpts = autoCapture.httpClientErrors;
    this.http4xxEnabled = clientErrorOpts !== false;
    const clientErrorExclude = typeof clientErrorOpts === 'object' && clientErrorOpts !== null ? clientErrorOpts.exclude : undefined;
    this.http4xxExclude = new Set(clientErrorExclude || [401, 404]);
    const caughtOpts = autoCapture.caughtExceptions;
    const caughtConfig = typeof caughtOpts === 'object' && caughtOpts !== null ? caughtOpts : {};
    this.caughtReportPolicy = caughtConfig.report || 'request-failure';

    if (caughtOpts) {
      const isProduction = process.env.NODE_ENV === 'production';

      if (isProduction && !caughtConfig.allowInProduction) {
        console.warn(
          '[VantaTrace] WARNING: autoCapture.caughtExceptions was requested but is auto-disabled in production ' +
          '(NODE_ENV=production). The V8 inspector watcher it relies on (Debugger.setPauseOnExceptions(\'all\')) ' +
          'is a real operational risk — it can block the event loop and cause latency spikes on every thrown ' +
          'exception, not just this feature\'s own overhead. Use @vantatrace/sdk/babel-plugin instead for ' +
          'production-safe, compile-time try/catch instrumentation, or set ' +
          'autoCapture.caughtExceptions.allowInProduction: true to enable it anyway.'
        );
      } else {
        if (isProduction) {
          console.warn(
            '[VantaTrace] WARNING: Runtime caught-exception capture (V8 inspector watcher) is enabled in production ' +
            '(allowInProduction: true). This is a high-risk operational choice that can block the event loop and ' +
            'cause latency spikes. Consider using compile-time AST instrumentation (@vantatrace/babel-plugin) instead.'
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
    }

    if (this.debug) {
      console.log(`[VantaTrace] Initialized SDK.`);
    }

    // Start background system telemetry sampler (runs every 10 seconds, unrefed)
    startTelemetrySampling(10000);

    // Periodic drop-visibility report — independent of `debug`, so a
    // production deployment isn't blind to its own dropped events (rate
    // limiting, sampling, transport backpressure, exhausted retries). Only
    // logs when something was actually dropped in the interval; unrefed so
    // it never keeps the process alive.
    this.dropReportInterval = setInterval(() => this._reportDropsIfAny(), 60000);
    this.dropReportInterval.unref?.();

    // Initialize HTTP/HTTPS hooks for breadcrumbs + span timing
    this._patchHttp();

    // Best-effort DB/Redis client auto-instrumentation for the span waterfall —
    // each is a no-op if the corresponding package isn't installed.
    const startSpanFn: (type: SpanType, name: string) => { end: () => void } = (type, name) => this.startSpan(type, name);
    tryPatchPg(startSpanFn, this.debug);
    tryPatchMysql2(startSpanFn, this.debug);
    tryPatchIoredis(startSpanFn, this.debug);

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
    if (this.dropReportInterval) {
      clearInterval(this.dropReportInterval);
      this.dropReportInterval = null;
    }
  }

  /**
   * Snapshot of events dropped since the last periodic report (rate limiting,
   * sampling, transport backpressure, exhausted retries, disabled API key).
   * Poll this yourself for alerting, or rely on the automatic summary logged
   * every 60 seconds when anything was actually dropped.
   */
  public getDropStats() {
    const rl = this.rateLimiter.getDropStats();
    const transport = getTransportDropStats();
    return {
      rateLimitGlobal: rl.rateLimitGlobal,
      rateLimitFingerprint: rl.rateLimitFingerprint,
      sampledOut: rl.sampledOut,
      backpressureSoft: transport.backpressureSoft,
      backpressureHard: transport.backpressureHard,
      apiKeyDisabled: transport.apiKeyDisabled,
      sendFailureExhausted: transport.sendFailureExhausted,
      total:
        rl.rateLimitGlobal + rl.rateLimitFingerprint + rl.sampledOut +
        transport.backpressureSoft + transport.backpressureHard +
        transport.apiKeyDisabled + transport.sendFailureExhausted
    };
  }

  /** Logs and resets the drop counters — called on the 60s interval; only warns when something was actually dropped. */
  private _reportDropsIfAny(): void {
    try {
      const stats = this.getDropStats();
      if (stats.total > 0) {
        console.warn(
          `[VantaTrace] WARNING: ${stats.total} event(s) dropped in the last ~60s — ` +
          `rateLimitGlobal=${stats.rateLimitGlobal}, rateLimitFingerprint=${stats.rateLimitFingerprint}, ` +
          `sampledOut=${stats.sampledOut}, backpressureSoft=${stats.backpressureSoft}, ` +
          `backpressureHard=${stats.backpressureHard}, apiKeyDisabled=${stats.apiKeyDisabled}, ` +
          `sendFailureExhausted=${stats.sendFailureExhausted}. Call getDropStats() to monitor this programmatically.`
        );
      }
      this.rateLimiter.resetDropStats();
      resetTransportDropStats();
    } catch (_) {
      // Never let reporting itself crash the sampler
    }
  }

  /**
   * Generate a lightweight hex trace ID for cross-cutting correlation.
   * Links Winston/Pino log entries with the same VantaTrace error event on the dashboard.
   */
  private _generateTraceId(): string {
    return crypto.randomUUID().replace(/-/g, '');
  }

  /**
   * Get the trace ID associated with the current request context, if any.
   * Useful for linking custom Winston/Pino logger entries to VantaTrace error events.
   */
  public static getActiveTraceId(): string | undefined {
    const store = requestStorage.getStore() as any;
    return store?.traceId;
  }

  /**
   * Primary method to capture exceptions and send them to VantaTrace
   */
  public captureException(error: any, context?: VantaTraceContext): void {
    if (this._isCapturing()) return;

    // Mark the active request as "an error was reported" so the auto-capture
    // finalizer doesn't emit a duplicate/synthetic event for the same request.
    const requestStore = requestStorage.getStore() as any;
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

      // Proactive volume control — checked before any of the more expensive
      // work below (system context sampling, context merging, payload
      // construction). Applies to every capture path (manual, uncaught,
      // synthetic 4xx/5xx, caught-exception watcher) since they all funnel
      // through this method.
      if (!this.rateLimiter.shouldAllow(normalized.fingerprint)) {
        if (this.debug) {
          console.log(`[VantaTrace] Event rate-limited/sampled out: ${normalized.name} - ${normalized.message}`);
        }
        return;
      }

      const systemContext = getSystemContext();

      // Auto-extract request-level context from AsyncLocalStorage store
      const activeStore = requestStorage.getStore() as any;
      
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
      const activeContext: any = buildRequestContext(req, () => this._generateTraceId(), (val) => this.maskData(val));

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
      requestStorage.run(activeContext, () => {
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
    const store = requestStorage.getStore() as any;
    if (!store) return;
    if (!store._vantaCaughtErrors) store._vantaCaughtErrors = [];
    if (store._vantaCaughtErrors.length < MAX_BUFFERED_CAUGHT_ERRORS) {
      store._vantaCaughtErrors.push(error);
    }
  }

  /**
   * Response finalizer for auto-capture. When a request ends with a failure
   * status (5xx, or an eligible 4xx) and no exception was reported for it,
   * this reports the real caught exception (when the inspector watcher
   * recorded one) or a synthetic HttpServerError/HttpClientError so the
   * failure is visible on the dashboard even when application code handled
   * it gracefully (e.g. `res.status(400).json(...)` with no throw).
   */
  private _onRequestFinished(store: any, req: any, res: any): void {
    finishAutoCapture(
      {
        http5xxEnabled: this.http5xxEnabled,
        http4xxEnabled: this.http4xxEnabled,
        http4xxExclude: this.http4xxExclude,
        hasCaughtWatcher: !!this.stopCaughtWatcher,
        captureException: (error, context) => this.captureException(error, context)
      },
      store,
      req,
      res
    );
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
    const self = this;
    patchConsole({
      isCapturing: () => self._isCapturing(),
      captureException: (error, context) => self.captureException(error, context),
      addBreadcrumb: (breadcrumb) => self.addBreadcrumb(breadcrumb)
    });
  }

  /**
   * Public helper to record manual breadcrumbs
   */
  public addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'timestamp'>): void {
    try {
      const store = requestStorage.getStore() as any;
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
   * Redacts fields matching `maskingKeys` (plus a small built-in default
   * list) from an arbitrary object — used to sanitize log metadata pulled in
   * from outside the SDK's own request context (e.g. a Winston log's data)
   * before it's attached to a captured error or breadcrumb.
   */
  public maskData(value: any): any {
    try {
      return this.masker(value);
    } catch (_) {
      return value;
    }
  }

  /**
   * Starts a timed span (an outbound HTTP call, DB query, Redis command, or any
   * custom sub-operation) scoped to the active request. Call `.end()` when the
   * operation completes; recorded spans are attached to the next captured
   * error on this request and rendered as a waterfall on the dashboard.
   * A no-op outside a request scope (requestHandler() not in the call chain).
   */
  public startSpan(type: SpanType, name: string): { end: () => void } {
    const store = requestStorage.getStore() as any;
    const startTime = Date.now();
    const id = crypto.randomUUID().replace(/-/g, '');
    let ended = false;

    return {
      end: () => {
        if (ended || !store) return;
        ended = true;
        try {
          if (!store.spans) store.spans = [];
          if (store.spans.length >= MAX_SPANS_PER_REQUEST) store.spans.shift();
          const endTime = Date.now();
          const span: Span = { id, type, name, startTime, endTime, duration: endTime - startTime };
          store.spans.push(span);
        } catch (_) {}
      }
    };
  }

  /**
   * Safe monkey-patching of outbound HTTP and HTTPS requests to log network breadcrumbs
   */
  private _patchHttp(): void {
    const self = this;
    patchHttp({
      apiUrl: this.apiUrl,
      addBreadcrumb: (breadcrumb) => self.addBreadcrumb(breadcrumb),
      startSpan: (type, name) => self.startSpan(type, name)
    });
  }

  /**
   * Safe conditional patching of Winston
   */
  private _tryPatchWinston(): void {
    try {
      const winston = dynamicRequire('winston');
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
    const self = this;
    tryPatchPino({
      debug: this.debug,
      isCapturing: () => self._isCapturing(),
      captureException: (error, context) => self.captureException(error, context)
    });
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
      const activeStore = requestStorage.getStore() as any || {};

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
export { flushAllQueues } from './transport';
export * from './types';
export { generateTraceId, generateSpanId, parseTraceParent, buildTraceParent, ParsedTraceParent } from './tracecontext';
export default VantaTrace;
