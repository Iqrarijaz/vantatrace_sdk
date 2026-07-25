export interface VantaTraceOptions {
  apiKey: string;
  debug?: boolean;
  apiUrl?: string;
  /** Extra key names (case-insensitive substring match) to redact from request bodies, query params, and error `extra`/metadata payloads, in addition to the SDK's built-in list (password, token, secret, cookie, ssn, credit card, etc.). */
  sensitiveKeys?: string[];
  /** Extra regexes to redact from free-text values (error messages/stacks, query strings) in addition to the SDK's built-in patterns (password=/token= pairs, Bearer tokens, JWTs, SSNs, credit-card-like digit runs, emails). Use the `g` flag to replace every match. */
  sensitivePatterns?: RegExp[];
}

export interface VantaTraceContext {
  userId?: string;
  route?: string;
  method?: string;
  ip?: string;
  headers?: Record<string, any>;
  metadata?: Record<string, any>;
  severity?: 'critical' | 'warning' | 'info';
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
  };
  severity?: 'critical' | 'warning' | 'info';
}
