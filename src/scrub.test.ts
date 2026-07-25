import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubString, deepScrub } from './scrub';

test('scrubString redacts key=value password/token pairs embedded in free text', () => {
  const input = 'Login failed: password=hunter2 for user bob';
  const out = scrubString(input);
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes('[REDACTED]'));
});

test('scrubString redacts query-string style secrets', () => {
  const input = 'GET /reset?token=abc123XYZ&next=/dashboard';
  const out = scrubString(input);
  assert.ok(!out.includes('abc123XYZ'));
});

test('scrubString redacts Bearer tokens', () => {
  const input = 'Authorization: Bearer sk_live_abcdef1234567890';
  const out = scrubString(input);
  assert.ok(!out.includes('sk_live_abcdef1234567890'));
  assert.ok(out.includes('[REDACTED]'));
});

test('scrubString redacts JWT-shaped tokens', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYE';
  const input = `session=${jwt}`;
  const out = scrubString(input);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('scrubString redacts SSNs and credit-card-like digit runs', () => {
  const ssn = scrubString('SSN on file: 123-45-6789');
  assert.ok(!ssn.includes('123-45-6789'));

  const cc = scrubString('Card declined: 4111 1111 1111 1111');
  assert.ok(!cc.includes('4111 1111 1111 1111'));
});

test('scrubString redacts email addresses', () => {
  const out = scrubString('Failed to notify user jane.doe@example.com');
  assert.ok(!out.includes('jane.doe@example.com'));
});

test('scrubString leaves ordinary error text untouched', () => {
  const input = "Cannot read properties of undefined (reading 'foo')";
  assert.equal(scrubString(input), input);
});

test('scrubString supports custom sensitivePatterns', () => {
  const out = scrubString('internal ref ACME-12345', {
    sensitivePatterns: [/ACME-\d+/g]
  });
  assert.ok(!out.includes('ACME-12345'));
});

test('deepScrub redacts sensitive keys at any nesting depth', () => {
  const input = {
    user: { name: 'Bob', password: 'hunter2', nested: { apiKey: 'sk_test_123' } },
    token: 'abc'
  };
  const out = deepScrub(input);
  assert.equal(out.user.password, '[REDACTED]');
  assert.equal(out.user.nested.apiKey, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.user.name, 'Bob');
});

test('deepScrub redacts sensitive values inside arrays', () => {
  const input = { users: [{ password: 'a' }, { password: 'b' }] };
  const out = deepScrub(input);
  assert.equal(out.users[0].password, '[REDACTED]');
  assert.equal(out.users[1].password, '[REDACTED]');
});

test('deepScrub also pattern-scrubs string values under non-sensitive keys', () => {
  const input = { note: 'contact me at jane@example.com' };
  const out = deepScrub(input);
  assert.ok(!out.note.includes('jane@example.com'));
});

test('deepScrub supports custom sensitiveKeys', () => {
  const input = { internalTraceSecret: 'do-not-log-this', name: 'ok' };
  const out = deepScrub(input, { sensitiveKeys: ['internaltracesecret'] });
  assert.equal(out.internalTraceSecret, '[REDACTED]');
  assert.equal(out.name, 'ok');
});

test('deepScrub does not crash on circular references and caps depth', () => {
  const circular: any = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => deepScrub(circular));
});

test('deepScrub caps array length to avoid pathological payloads', () => {
  const bigArray = Array.from({ length: 500 }, (_, i) => i);
  const out = deepScrub({ items: bigArray });
  assert.ok(out.items.length <= 100);
});

test('deepScrub passes through null/undefined/primitives unchanged', () => {
  assert.equal(deepScrub(null), null);
  assert.equal(deepScrub(undefined), undefined);
  assert.equal(deepScrub(42), 42);
  assert.equal(deepScrub(true), true);
});
