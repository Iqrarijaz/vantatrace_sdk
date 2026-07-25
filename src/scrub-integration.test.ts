import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { VantaTrace } from './index';
import { _resetForTests } from './registry';

// sendPayload batches/sends over a real HTTP connection (with its own DNS
// cache, keep-alive agents, and setImmediate-deferred flush), so rather than
// trying to mock internals that don't expose a clean seam, these tests point
// the SDK at a local HTTP server and inspect what actually hits the wire —
// the same thing ClickHouse/the ingest endpoint would receive.
let server: http.Server;
let baseUrl: string;
let received: any[];

beforeEach(async () => {
  _resetForTests();
  received = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push(body);
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/events`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Polls `received` until at least one batch has arrived, or times out. */
async function waitForBatch(timeoutMs = 2000): Promise<any[]> {
  const start = Date.now();
  while (received.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for the SDK to send a batch');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return received[0];
}

test('requestHandler + captureException scrub a password embedded in the request body', async () => {
  const vt = new VantaTrace({ apiKey: 'test-key', apiUrl: baseUrl, debug: false });
  const middleware = vt.requestHandler();

  const req: any = {
    body: { username: 'bob', password: 'hunter2' },
    query: {},
    headers: {},
    method: 'POST',
    path: '/login'
  };

  middleware(req, {}, () => {
    vt.captureException(new Error('login failed'));
  });

  const batch = await waitForBatch();
  const sentBody = batch[0].context.metadata.body;
  assert.equal(sentBody.password, '[REDACTED]');
  assert.equal(sentBody.username, 'bob');
});

test('requestHandler scrubs secrets embedded in query parameters', async () => {
  const vt = new VantaTrace({ apiKey: 'test-key', apiUrl: baseUrl, debug: false });
  const middleware = vt.requestHandler();

  const req: any = {
    body: {},
    query: { token: 'abc123secretXYZ', page: '2' },
    headers: {},
    method: 'GET',
    path: '/search'
  };

  middleware(req, {}, () => {
    vt.captureException(new Error('search failed'));
  });

  const batch = await waitForBatch();
  const sentQuery = batch[0].context.metadata.query;
  assert.equal(sentQuery.token, '[REDACTED]');
  assert.equal(sentQuery.page, '2');
});

test('captureException scrubs PII embedded directly in the error message', async () => {
  const vt = new VantaTrace({ apiKey: 'test-key', apiUrl: baseUrl, debug: false });

  vt.captureException(new Error('Failed to charge card 4111 1111 1111 1111 for jane@example.com'));

  const batch = await waitForBatch();
  const sentMessage = batch[0].error.message;
  assert.ok(!sentMessage.includes('4111 1111 1111 1111'));
  assert.ok(!sentMessage.includes('jane@example.com'));
});

test('captureException scrubs custom metadata passed directly (not just requestHandler-derived metadata)', async () => {
  const vt = new VantaTrace({ apiKey: 'test-key', apiUrl: baseUrl, debug: false });

  vt.captureException(new Error('boom'), {
    metadata: { internalNote: 'password=supersecret123' }
  });

  const batch = await waitForBatch();
  const sentMetadata = batch[0].context.metadata;
  assert.ok(!sentMetadata.internalNote.includes('supersecret123'));
});

test('custom sensitiveKeys option redacts application-specific fields', async () => {
  const vt = new VantaTrace({ apiKey: 'test-key', apiUrl: baseUrl, debug: false, sensitiveKeys: ['internalAuditId'] });
  const middleware = vt.requestHandler();

  const req: any = {
    body: { internalAuditId: 'do-not-log-12345', name: 'ok' },
    query: {},
    headers: {},
    method: 'POST',
    path: '/audit'
  };

  middleware(req, {}, () => {
    vt.captureException(new Error('audit failed'));
  });

  const batch = await waitForBatch();
  const sentBody = batch[0].context.metadata.body;
  assert.equal(sentBody.internalAuditId, '[REDACTED]');
  assert.equal(sentBody.name, 'ok');
});

test('requestHandler still redacts standard sensitive headers by key name', async () => {
  const vt = new VantaTrace({ apiKey: 'test-key', apiUrl: baseUrl, debug: false });
  const middleware = vt.requestHandler();

  const req: any = {
    body: {},
    query: {},
    headers: { authorization: 'Bearer secrettoken', 'x-custom': 'keep-me' },
    method: 'GET',
    path: '/me'
  };

  middleware(req, {}, () => {
    vt.captureException(new Error('boom'));
  });

  const batch = await waitForBatch();
  const sentHeaders = batch[0].context.headers;
  assert.equal(sentHeaders.authorization, '[REDACTED]');
  assert.equal(sentHeaders['x-custom'], 'keep-me');
});
