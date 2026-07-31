/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) parsing and
 * generation. Lets a captured error's trace ID interoperate with any other
 * W3C-compliant tracing system across a service boundary — an upstream
 * service (VantaTrace-instrumented or not) that sends a `traceparent`
 * header gets its trace continued rather than restarted, and this service's
 * own outbound calls carry a `traceparent` so a downstream service can do
 * the same.
 *
 * `traceparent` format: `{version}-{trace-id}-{parent-id}-{trace-flags}`
 * - version: 2 hex chars (always "00" for the current spec version).
 * - trace-id: 32 hex chars (16 bytes), not all zeros.
 * - parent-id: 16 hex chars (8 bytes) — the sending party's own span ID, not all zeros.
 * - trace-flags: 2 hex chars; bit 0 is the "sampled" flag.
 */

import * as crypto from 'crypto';

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

export interface ParsedTraceParent {
  version: string;
  traceId: string;
  parentId: string;
  flags: string;
}

/** Generates a W3C-compliant 32-hex-char trace ID. */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Generates a W3C-compliant 16-hex-char span ID. */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Parses a `traceparent` header value. Returns `null` (never throws) for
 * anything malformed, using an unsupported version format, or carrying an
 * all-zero trace-id/parent-id — those are explicitly invalid per spec and
 * should be treated the same as "no incoming trace" rather than propagated.
 */
export function parseTraceParent(header: string | undefined | null): ParsedTraceParent | null {
  if (typeof header !== 'string') return null;

  const match = header.trim().match(TRACEPARENT_RE);
  if (!match) return null;

  const [, version, traceId, parentId, flags] = match;
  const lowerTraceId = traceId.toLowerCase();
  const lowerParentId = parentId.toLowerCase();
  if (lowerTraceId === ALL_ZERO_TRACE_ID || lowerParentId === ALL_ZERO_SPAN_ID) return null;

  return { version: version.toLowerCase(), traceId: lowerTraceId, parentId: lowerParentId, flags: flags.toLowerCase() };
}

/**
 * Builds a `traceparent` header value. `flags` defaults to `"01"` (sampled)
 * — VantaTrace doesn't do head-based trace sampling (see the separate
 * event-level rate limiter), so every trace it participates in is marked
 * sampled for whatever downstream system consumes the header.
 */
export function buildTraceParent(traceId: string, spanId: string, flags: string = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}
