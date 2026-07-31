export interface CaughtExceptionCaptureOptions {
  /**
   * When to report exceptions that were handled inside a try/catch block:
   * - 'request-failure' (default): buffer caught exceptions per request and only
   *   report them if the request finishes with a 5xx response and no other error
   *   was captured. Zero noise from errors your code recovered from.
   * - 'always': report every caught exception immediately (severity 'warning'),
   *   even when the request ultimately succeeds.
   */
  report?: 'request-failure' | 'always';
  /**
   * Also capture exceptions whose throw site is inside node_modules.
   * Default: false — many libraries throw and catch internally as control flow,
   * which is pure noise for error tracking.
   */
  includeNodeModules?: boolean;
  /**
   * Ceiling on how many caught exceptions are recorded per minute (protects the
   * app from throw-heavy hot loops). Default: 120.
   */
  maxPerMinute?: number;
}

export interface AutoCaptureOptions {
  /**
   * Capture a synthetic error when a request finishes with a 5xx status code and
   * no exception was reported for that request (i.e. the error was swallowed in a
   * try/catch that responded with res.status(500)). Default: true.
   */
  http5xx?: boolean;
  /**
   * Capture a synthetic error when a request finishes with a 4xx status code and
   * no exception was reported — i.e. handled gracefully in application code
   * (e.g. `res.status(400).json(...)` with no throw), which a plain
   * try/catch-based error tracker would never see.
   *
   * - `true` (default): capture all 4xx except 401 and 404, which are routine
   *   (token expiry, bot/typo traffic) rather than defects.
   * - `false`: disabled entirely.
   * - `{ exclude: number[] }`: capture all 4xx except the given status codes
   *   (replaces the default `[401, 404]` exclusion list).
   */
  httpClientErrors?: boolean | { exclude?: number[] };
  /**
   * Runtime capture of exceptions handled inside try/catch blocks, powered by the
   * V8 inspector (`Debugger.setPauseOnExceptions('all')`). Captures the real Error
   * object — including engine-generated ReferenceError/TypeError — with its full
   * stack and request context, without touching any catch block.
   *
   * Opt-in: adds ~0.3–0.5ms of overhead per thrown exception while enabled
   * (near-zero when no exception is thrown). Default: false.
   */
  caughtExceptions?: boolean | CaughtExceptionCaptureOptions;
}

export interface RateLimitOptions {
  /** Max captured events per minute, globally, across all fingerprints. `false` disables the global cap. Default: 480 (8/sec). */
  maxPerMinute?: number | false;
  /** Max captured events per minute for a single error fingerprint. `false` disables the per-fingerprint cap. Default: 60 (1/sec). */
  maxPerFingerprintPerMinute?: number | false;
  /** Fraction of events (0..1) allowed through after rate-limit checks pass — an additional lever for services with a high sustained baseline of expected failures. Default: 1 (no sampling). */
  sampleRate?: number;
}

export interface VantaTraceOptions {
  apiKey: string;
  debug?: boolean;
  apiUrl?: string;
  /** Automatic error-capture behaviors that go beyond the Express error middleware. */
  autoCapture?: AutoCaptureOptions;
  /**
   * Additional field names (exact match, case-insensitive) to redact from
   * Winston log metadata before it's attached to a captured error or
   * breadcrumb — e.g. domain-specific PII your own log formatter already
   * masks (CNIC, ConsumerName, BankAccountNumber, ...) that wouldn't be
   * caught by generic password/token/secret-shaped pattern matching.
   * Merged with a small built-in default list.
   */
  maskingKeys?: string[];
  /**
   * Proactive volume control on captured events, checked before the
   * transport's reactive backpressure ceiling — protects both the host app
   * and the ingestion pipeline during an event storm (e.g. a downstream
   * dependency outage causing every request to fail at once), and ensures
   * one repeating error doesn't crowd out visibility into other failures.
   * See `getDropStats()` to monitor what this — and transport backpressure —
   * actually drops.
   */
  rateLimit?: RateLimitOptions;
}

export interface Breadcrumb {
  timestamp: string;
  category: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  type?: string;
  data?: Record<string, any>;
}

export interface UserContextInfo {
  id?: string;
  email?: string;
  role?: string;
  tenantId?: string;
  orgId?: string;
}

export interface GeoLocationInfo {
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
}

export type SpanType = 'http' | 'db' | 'redis' | 'custom';

/** A single timed sub-operation (outbound HTTP call, DB query, Redis command) within a request, used to render a request waterfall. */
export interface Span {
  id: string;
  type: SpanType;
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface VantaTraceContext {
  userId?: string;
  user?: UserContextInfo;
  route?: string;
  method?: string;
  ip?: string;
  headers?: Record<string, any>;
  body?: Record<string, any>;
  query?: Record<string, any>;
  geo?: GeoLocationInfo;
  duration?: number;
  featureFlags?: Record<string, any>;
  sessionId?: string;
  correlationId?: string;
  /** Phone number (MSISDN), normalized to digits with an optional leading '+'. */
  msisdn?: string;
  /** Client-reported app version, from the X-APP-VERSION header. */
  appVersion?: string;
  metadata?: Record<string, any>;
  severity?: 'critical' | 'warning' | 'info';
  breadcrumbs?: Breadcrumb[];
  /** Timed sub-operations captured during this request (outbound HTTP/DB/Redis calls), used to render a request waterfall. */
  spans?: Span[];
}

/** Normalized cause chain entry for errors thrown with { cause: originalError }. */
export interface NormalizedCause {
  name: string;
  message: string;
  stack: string;
  code?: string;
  statusCode?: number;
}

export interface ErrorPayload {
  apiKey: string;
  timestamp: string;
  /** Unique trace ID generated per capture — links Winston / logger entries with the same error event. */
  traceId: string;
  error: {
    message: string;
    stack: string;
    name: string;
    fingerprint: string;
    code?: string;
    statusCode?: number;
    extra?: Record<string, any>;
    /** Original error(s) from the cause chain (native `Error.cause` or manual `{ cause }` patterns). */
    cause?: NormalizedCause[];
  };
  context: VantaTraceContext;
  system: {
    nodeVersion: string;
    hostname: string;
    pid: number;
    platform: string;
    arch: string;
    memory: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external?: number;
      freeMem: number;
      totalMem: number;
    };
    loadavg: number[];
    uptime: number;
    /** Percentage of wall-clock time the process spent on CPU since the last sample. Can exceed 100 on multi-core work. */
    cpu?: {
      percent: number;
    };
    /** Mean event loop delay in milliseconds over the last sampling window — a proxy for how busy/blocked the event loop is. */
    eventLoopLag?: number;
  };
  severity?: 'critical' | 'warning' | 'info';
  breadcrumbs?: Breadcrumb[];
}
