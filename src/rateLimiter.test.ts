import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimiter';

test('allows events under both the global and per-fingerprint caps', () => {
  const rl = createRateLimiter({ maxPerMinute: 10, maxPerFingerprintPerMinute: 5 });
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.shouldAllow('fp-a'), true);
  }
  assert.deepEqual(rl.getDropStats(), { rateLimitGlobal: 0, rateLimitFingerprint: 0, sampledOut: 0 });
});

test('drops once the per-fingerprint cap is exceeded, even with global budget left', () => {
  const rl = createRateLimiter({ maxPerMinute: 100, maxPerFingerprintPerMinute: 3 });
  for (let i = 0; i < 3; i++) assert.equal(rl.shouldAllow('fp-a'), true);
  assert.equal(rl.shouldAllow('fp-a'), false, '4th occurrence of the same fingerprint is dropped');
  assert.equal(rl.getDropStats().rateLimitFingerprint, 1);
});

test('a different fingerprint is unaffected by another fingerprint hitting its cap', () => {
  const rl = createRateLimiter({ maxPerMinute: 100, maxPerFingerprintPerMinute: 2 });
  rl.shouldAllow('fp-a');
  rl.shouldAllow('fp-a');
  assert.equal(rl.shouldAllow('fp-a'), false, 'fp-a is now capped');
  assert.equal(rl.shouldAllow('fp-b'), true, 'fp-b has its own independent budget');
});

test('the global cap protects overall volume regardless of fingerprint diversity', () => {
  const rl = createRateLimiter({ maxPerMinute: 3, maxPerFingerprintPerMinute: 100 });
  assert.equal(rl.shouldAllow('fp-1'), true);
  assert.equal(rl.shouldAllow('fp-2'), true);
  assert.equal(rl.shouldAllow('fp-3'), true);
  assert.equal(rl.shouldAllow('fp-4'), false, 'global cap reached even though fp-4 has never been seen before');
  assert.equal(rl.getDropStats().rateLimitGlobal, 1);
});

test('maxPerMinute: false disables the global cap entirely', () => {
  const rl = createRateLimiter({ maxPerMinute: false, maxPerFingerprintPerMinute: false });
  for (let i = 0; i < 1000; i++) {
    assert.equal(rl.shouldAllow('same-fingerprint'), true);
  }
});

test('sampleRate: 0 drops everything as sampledOut', () => {
  const rl = createRateLimiter({ sampleRate: 0 });
  assert.equal(rl.shouldAllow('fp-a'), false);
  assert.equal(rl.getDropStats().sampledOut, 1);
});

test('sampleRate: 1 (default) never samples out', () => {
  const rl = createRateLimiter({ sampleRate: 1 });
  for (let i = 0; i < 50; i++) {
    assert.equal(rl.shouldAllow('fp-a' + i), true);
  }
});

test('resetDropStats clears counters without resetting the rate-limit window', () => {
  const rl = createRateLimiter({ maxPerMinute: 1 });
  assert.equal(rl.shouldAllow('fp-a'), true);
  assert.equal(rl.shouldAllow('fp-b'), false);
  assert.equal(rl.getDropStats().rateLimitGlobal, 1);

  rl.resetDropStats();
  assert.deepEqual(rl.getDropStats(), { rateLimitGlobal: 0, rateLimitFingerprint: 0, sampledOut: 0 });

  // Window itself wasn't reset — still capped at 1/minute, so this is still dropped.
  assert.equal(rl.shouldAllow('fp-c'), false);
});
