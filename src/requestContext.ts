import { parseTraceParent, buildTraceParent, generateSpanId } from './tracecontext';

/**
 * Builds the per-request AsyncLocalStorage context object from an incoming
 * Express request: user identity, MSISDN, sanitized body/query/headers, geo,
 * session/correlation IDs, and W3C trace-context continuation. Pure data
 * extraction — no Express response wiring or AsyncLocalStorage.run() here,
 * since those need the SDK instance's own auto-capture finalizer.
 */
export function buildRequestContext(req: any, generateTraceId: () => string): any {
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

  // W3C Trace Context (https://www.w3.org/TR/trace-context/) — only the
  // standards-compliant `traceparent` header is honored for continuing an
  // upstream trace (x-trace-id/x-correlation-id above stay informational
  // only; their format isn't guaranteed to be a valid 32-hex trace-id, and
  // feeding an arbitrary value into a spec-compliant header we then hand
  // to a downstream service would just push the malformed value further
  // down the chain). Trace ID generation is eager here (not lazily on
  // first captureException call, as before) so it's available for
  // outbound header injection even on requests that never error.
  const incomingTraceParentHeader =
    (typeof req.get === 'function' ? req.get('traceparent') : undefined) || req.headers?.['traceparent'];
  const parsedTraceParent = parseTraceParent(incomingTraceParentHeader);
  const traceId = parsedTraceParent ? parsedTraceParent.traceId : generateTraceId();
  const parentSpanId = parsedTraceParent ? parsedTraceParent.parentId : undefined;
  const spanId = generateSpanId();

  return {
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
    traceId,
    spanId,
    parentSpanId,
    traceparent: buildTraceParent(traceId, spanId),
    // Reserved for whatever a developer passes to captureException()'s own
    // `metadata` — auto-captured request data already has its own fields
    // above (body/query/etc.), so it isn't duplicated in here too.
    metadata: {},
    breadcrumbs: [],
    spans: []
  };
}
