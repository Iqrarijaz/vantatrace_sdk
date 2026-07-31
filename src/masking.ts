/**
 * Key-name-based masking for log metadata pulled in from outside the SDK's
 * own request context (e.g. Winston log objects) — separate from the
 * secret-shaped string scrubbing the backend already does, since a field
 * like `ConsumerName` or `CNIC` isn't password/token/digit-run shaped and
 * would otherwise pass through untouched.
 */

const DEFAULT_MASK_KEYS = [
  'password', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'authorization',
  'cookie', 'session', 'pin', 'mpin', 'cvv', 'cvc', 'privatekey', 'private_key',
  'creditcard', 'credit_card', 'cardnumber', 'card_number', 'clientsecret',
  'client_secret', 'accesskey', 'access_key', 'ssn'
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;

/**
 * Builds a masking function that redacts values whose object key matches
 * (case-insensitively, exact match) the built-in defaults or any
 * project-supplied `customKeys` — e.g. the same list a project already
 * maintains for its own log formatter (CNIC, ConsumerName, BankAccountNumber, ...).
 */
export function createMasker(customKeys: string[] = []): (value: any) => any {
  const keySet = new Set(
    [...DEFAULT_MASK_KEYS, ...customKeys].map((k) => k.trim().toLowerCase()).filter(Boolean)
  );

  const isSensitiveKey = (key: string): boolean => keySet.has(key.toLowerCase());

  const mask = (value: any, depth: number): any => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date || value instanceof Error) return value;
    if (depth >= MAX_DEPTH) return '[REDACTED_DEPTH_LIMIT]';

    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((item) => mask(item, depth + 1));
    }

    const output: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED;
        continue;
      }
      try {
        output[key] = mask(value[key], depth + 1);
      } catch (_) {
        output[key] = '[UNSERIALIZABLE]';
      }
    }
    return output;
  };

  return (value: any) => mask(value, 0);
}
