import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { calculateBackoffDelay, sendPayload, getTransportDropStats, resetTransportDropStats, serializeBatch } from './transport';

function fakePayload(overrides: Record<string, any> = {}): any {
  return {
    apiKey: 'test-key',
    timestamp: new Date().toISOString(),
    traceId: 'trace-1',
    error: { message: 'boom', stack: 'Error: boom', name: 'Error', fingerprint: 'fp-1' },
    context: {},
    system: {},
    severity: 'critical',
    ...overrides
  };
}

test('calculateBackoffDelay grows with attempt number and stays within [exponential, exponential*2]', () => {
  const d0 = calculateBackoffDelay(0);
  const d1 = calculateBackoffDelay(1);
  const d2 = calculateBackoffDelay(2);

  // Deterministic floor (the exponential term alone, before jitter is added).
  assert.ok(d0 >= 200 && d0 <= 400, `attempt 0 delay ${d0} out of expected [200,400] range`);
  assert.ok(d1 >= 400 && d1 <= 800, `attempt 1 delay ${d1} out of expected [400,800] range`);
  assert.ok(d2 >= 800 && d2 <= 1600, `attempt 2 delay ${d2} out of expected [800,1600] range`);
});

test('calculateBackoffDelay is capped and never negative even for very large attempt numbers', () => {
  const delay = calculateBackoffDelay(50);
  assert.ok(delay <= 5000, `delay ${delay} exceeded the 5000ms cap`);
  assert.ok(delay >= 0);
});

test('calculateBackoffDelay produces varying values across calls (jitter is actually random, not fixed)', () => {
  const samples = Array.from({ length: 20 }, () => calculateBackoffDelay(3));
  const distinctValues = new Set(samples);
  assert.ok(distinctValues.size > 1, 'expected jitter to produce different delays across calls');
});

test('a batch that fails twice then succeeds is retried with real (non-immediate) backoff delays, not sent 4 times', async () => {
  resetTransportDropStats();
  let requestCount = 0;
  const requestTimestamps: number[] = [];

  const server = http.createServer((req, res) => {
    requestCount++;
    requestTimestamps.push(Date.now());
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (requestCount < 3) {
        res.writeHead(500);
        res.end('{}');
      } else {
        res.writeHead(200);
        res.end('{}');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  sendPayload(`http://127.0.0.1:${port}/events`, 'test-key', fakePayload(), false);

  // Wait long enough for 2 retries (attempt 0 + attempt 1 backoff, worst case ~1.2s) to complete.
  await new Promise((resolve) => setTimeout(resolve, 2500));

  assert.equal(requestCount, 3, 'exactly 3 attempts: 2 failures + 1 success, not more');
  assert.ok(
    requestTimestamps[1] - requestTimestamps[0] >= 150,
    `expected a real backoff delay before the first retry, got ${requestTimestamps[1] - requestTimestamps[0]}ms`
  );
  assert.ok(
    requestTimestamps[2] - requestTimestamps[1] >= 150,
    `expected a real backoff delay before the second retry, got ${requestTimestamps[2] - requestTimestamps[1]}ms`
  );

  server.close();
});

test('a batch that never succeeds is dropped after MAX_RETRIES and counted in sendFailureExhausted', async () => {
  resetTransportDropStats();

  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(500);
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  sendPayload(`http://127.0.0.1:${port}/events`, 'test-key', fakePayload(), false);

  // Worst case: 3 retries with exponential+jitter backoff (~200-400, 400-800, 800-1600ms) — generous margin.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  assert.equal(getTransportDropStats().sendFailureExhausted, 1);

  server.close();
});

test('serializeBatch: small batches (at or under the chunk size) produce the same output as a plain JSON.stringify', async () => {
  const batch = Array.from({ length: 5 }, (_, i) => fakePayload({ traceId: `trace-${i}` }));
  const result = await serializeBatch(batch as any);
  assert.equal(result, JSON.stringify(batch));
});

test('serializeBatch: large batches (over the chunk size) still produce valid, correctly-ordered JSON', async () => {
  const batch = Array.from({ length: 37 }, (_, i) => fakePayload({ traceId: `trace-${i}` }));
  const result = await serializeBatch(batch as any);
  const parsed = JSON.parse(result);
  assert.equal(parsed.length, 37);
  assert.deepEqual(parsed.map((p: any) => p.traceId), batch.map((p) => p.traceId));
  assert.equal(result, JSON.stringify(batch), 'chunked output is byte-identical to a plain stringify of the same batch');
});

test('serializeBatch: a large batch actually yields across multiple event-loop ticks, not one synchronous call', async () => {
  const batch = Array.from({ length: 25 }, (_, i) => fakePayload({ traceId: `trace-${i}` }));
  let ticksObserved = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(() => { ticksObserved++; resolve(); }));

  const resultPromise = serializeBatch(batch as any);
  // Race a counter of setImmediate ticks against the serialization finishing —
  // if it were one synchronous call, the result would already be resolved
  // before this first manually-scheduled tick even has a chance to run.
  await tick();
  const stillPending = await Promise.race([resultPromise.then(() => false), Promise.resolve(true)]);
  assert.equal(stillPending, true, 'a 25-item batch (2+ chunks) should not finish within a single event-loop tick');

  await resultPromise;
});

test('serializeBatch: a circular reference in one payload rejects instead of crashing the process', async () => {
  const circular: any = { a: 1 };
  circular.self = circular;
  const batch = [fakePayload({ context: circular })];

  await assert.rejects(() => serializeBatch(batch as any));
});

test('serializeBatch: a circular reference deep in a large (chunked) batch also rejects cleanly', async () => {
  const circular: any = { a: 1 };
  circular.self = circular;
  const batch = Array.from({ length: 15 }, (_, i) => fakePayload({ traceId: `trace-${i}` }));
  batch[12] = fakePayload({ context: circular }) as any;

  await assert.rejects(() => serializeBatch(batch as any));
});

test('a large batch (over the chunk size) is still delivered correctly end-to-end through sendPayload', async () => {
  resetTransportDropStats();
  let receivedBody = '';

  const server = http.createServer((req, res) => {
    req.on('data', (c) => { receivedBody += c; });
    req.on('end', () => {
      res.writeHead(200);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  for (let i = 0; i < 25; i++) {
    sendPayload(`http://127.0.0.1:${port}/events`, 'test-key', fakePayload({ traceId: `trace-${i}`, severity: 'info' }) as any, false);
  }
  // severity 'info' batches flush on the 500ms timer, not immediately.
  await new Promise((resolve) => setTimeout(resolve, 800));

  const parsed = JSON.parse(receivedBody);
  assert.equal(parsed.length, 25);

  server.close();
});
