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

export interface VantaTraceOptions {
  apiKey: string;
  debug?: boolean;
  apiUrl?: string;
  /** Logical service name attached to every event (shown on the dashboard). */
  serviceName?: string;
  /** Automatic error-capture behaviors that go beyond the Express error middleware. */
  autoCapture?: AutoCaptureOptions;
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
  metadata?: Record<string, any>;
  severity?: 'critical' | 'warning' | 'info';
  breadcrumbs?: Breadcrumb[];
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
  serviceName?: string;
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
  };
  severity?: 'critical' | 'warning' | 'info';
  breadcrumbs?: Breadcrumb[];
}
