/**
 * Recursive PII/secret scrubbing for anything captured by the SDK before it
 * leaves the process: request bodies, query strings, arbitrary error `extra`
 * properties, and free-text error messages/stacks. Header redaction (a
 * simple key allowlist check) already happens separately in index.ts — this
 * module covers the payload shapes headers redaction doesn't reach.
 */

/** Key names (case-insensitive substring match) whose value is always redacted, wherever they appear in an object. */
const DEFAULT_SENSITIVE_KEY_PATTERN =
  /pass(word)?|pwd|secret|token|api[_-]?key|auth(orization)?|cookie|session|ssn|social[_-]?security|cvv|cvc\b|pin(code)?|private[_-]?key|credit[_-]?card|card[_-]?number|client[_-]?secret|access[_-]?key/i;

/** Pattern-based redaction applied to string *values* (including inside error messages/stacks/query strings), since secrets can be embedded in free text rather than isolated behind a matching key name. */
const DEFAULT_STRING_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token> — must run before the generic key=value
  // pattern below, which would otherwise match "Authorization: Bearer" as
  // the key and just the literal word "Bearer" as its value, leaving the
  // actual token that follows untouched.
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // JWT-shaped tokens (header.payload.signature, base64url segments)
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  // key=value / key: value pairs where the key name looks sensitive (covers
  // query strings like ?password=hunter2 and log-style "token: abc123").
  /\b(pass(?:word)?|pwd|secret|token|api[_-]?key|auth(?:orization)?|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[^\s'",;&}]+/gi,
  // US Social Security Numbers
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // Credit-card-like digit runs (13-19 digits, optionally space/dash separated)
  /\b(?:\d[ -]?){12,18}\d\b/g,
  // Email addresses
  /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 10000;

export interface ScrubOptions {
  /** Extra key names (case-insensitive substring match) to redact in addition to the built-in list. */
  sensitiveKeys?: string[];
  /** Extra regexes to redact from string values in addition to the built-in patterns. Must be global (`g` flag) if they should replace all matches. */
  sensitivePatterns?: RegExp[];
}

function buildKeyMatcher(extraKeys: string[] | undefined): (key: string) => boolean {
  const extra = (extraKeys || []).map((k) => k.toLowerCase()).filter(Boolean);
  return (key: string) => {
    if (DEFAULT_SENSITIVE_KEY_PATTERN.test(key)) return true;
    if (extra.length === 0) return false;
    const lowerKey = key.toLowerCase();
    return extra.some((needle) => lowerKey.includes(needle));
  };
}

/** Redacts secret-shaped substrings inside a free-text string (error messages, stacks, raw query strings). Never throws — returns the original string on any regex failure. */
export function scrubString(input: string, options?: ScrubOptions): string {
  if (typeof input !== 'string' || input.length === 0) return input;

  const truncated = input.length > MAX_STRING_LENGTH ? input.slice(0, MAX_STRING_LENGTH) : input;
  const patterns = [...DEFAULT_STRING_PATTERNS, ...(options?.sensitivePatterns || [])];

  let result = truncated;
  for (const pattern of patterns) {
    try {
      result = result.replace(pattern, REDACTED);
    } catch {
      // A malformed custom pattern shouldn't break the whole capture pipeline.
    }
  }
  return input.length > MAX_STRING_LENGTH ? `${result}...[TRUNCATED]` : result;
}

/**
 * Recursively walks an arbitrary value (request body, query object, error
 * `extra` payload, custom metadata) and redacts:
 *  - any value whose key name matches a sensitive-key pattern
 *  - secret-shaped substrings inside string values that aren't already fully redacted
 * Depth and array-length are capped so a deeply nested or huge payload can't
 * cause runaway recursion or excessive scanning time.
 */
export function deepScrub(value: any, options?: ScrubOptions, depth = 0): any {
  const isSensitiveKey = buildKeyMatcher(options?.sensitiveKeys);
  return scrubValue(value, isSensitiveKey, options, depth);
}

function scrubValue(value: any, isSensitiveKey: (key: string) => boolean, options: ScrubOptions | undefined, depth: number): any {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return scrubString(value, options);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[REDACTED_DEPTH_LIMIT]';
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, MAX_ARRAY_ITEMS);
    return limited.map((item) => scrubValue(item, isSensitiveKey, options, depth + 1));
  }

  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }

  const output: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    try {
      output[key] = scrubValue(value[key], isSensitiveKey, options, depth + 1);
    } catch {
      // Getter threw, circular structure, etc. — drop the value rather than crash capture.
      output[key] = '[UNSERIALIZABLE]';
    }
  }
  return output;
}
