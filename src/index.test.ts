import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { VantaTrace } from './index';
import { getGlobalInstance, captureExceptionGlobal, _resetForTests } from './registry';

type CapturedCall = { error: any; context: any };

/** Replace captureException with a spy that still marks the request store (like the real one). */
function spyOnCapture(instance: VantaTrace): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const original = instance.captureException.bind(instance);
  instance.captureException = (error: any, context?: any) => {
    calls.push({ error, context });
    return original(error, context);
  };
  return calls;
}

function fakeReqRes(statusCode: number, opts: { query?: any } = {}) {
  const req: any = { method: 'GET', url: '/api/v1/check', path: '/api/v1/check', headers: {}, query: opts.query || {} };
  const res: any = new EventEmitter();
  res.statusCode = statusCode;
  return { req, res };
}

/** Adds Express-style res.json/res.send so requestHandler()'s response-body capture has something to patch. */
function withJsonSend(res: any) {
  res.json = (body: any) => { res._sentBody = body; return res; };
  res.send = (body: any) => { res._sentBody = body; return res; };
  return res;
}

test('constructing VantaTrace registers it as the global singleton', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  assert.equal(getGlobalInstance(), instance);
});

test('captureExceptionGlobal reaches captureException on the constructed instance', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });

  let seenError: any = null;
  const originalCapture = instance.captureException.bind(instance);
  instance.captureException = (error: any, context?: any) => {
    seenError = error;
    return originalCapture(error, context);
  };

  const err = new Error('integration boom');
  captureExceptionGlobal(err);

  assert.equal(seenError, err);
});

test('5xx response with no reported error emits a synthetic HttpServerError', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);

  const handler = instance.requestHandler();
  handler(req, res, () => {
    // Route swallows an error silently and responds 500 — nothing captured here.
  });
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].error.name, 'HttpServerError');
  assert.match(calls[0].error.message, /GET \/api\/v1\/check responded with HTTP 500/);
  assert.equal(calls[0].context.metadata.captureStrategy, 'http5xx');
  assert.equal(calls[0].context.metadata.httpStatusCode, 500);
  assert.equal(calls[0].context.severity, 'critical');
});

test('successful (non-5xx) responses emit nothing', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(404);

  instance.requestHandler()(req, res, () => {});
  res.emit('finish');

  assert.equal(calls.length, 0);
});

test('autoCapture.http5xx: false disables the synthetic capture', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false, autoCapture: { http5xx: false } });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);

  instance.requestHandler()(req, res, () => {});
  res.emit('finish');

  assert.equal(calls.length, 0);
});

test('a manual captureException during the request suppresses the 5xx synthetic', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);

  instance.requestHandler()(req, res, () => {
    // Developer already reported the error inside the catch block.
    instance.captureException(new Error('order processing failed'), { severity: 'warning' });
  });
  res.emit('finish');

  assert.equal(calls.length, 1, 'only the manual capture — no synthetic duplicate');
  assert.equal(calls[0].error.message, 'order processing failed');
});

test('buffered caught exceptions are reported as the root cause of a 5xx response', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);

  const rootCause = new ReferenceError('a is not defined');
  const cascade = new Error('fallback also failed');

  instance.requestHandler()(req, res, () => {
    // Simulate what the inspector watcher records at each throw site.
    (instance as any)._recordCaughtException(rootCause, { uncaught: false, frameUrl: '/app/routes.js' });
    (instance as any)._recordCaughtException(cascade, { uncaught: false, frameUrl: '/app/routes.js' });
  });
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].error, rootCause, 'first caught exception wins (root cause)');
  assert.equal(calls[0].context.metadata.captureStrategy, 'caughtException');
  assert.equal(calls[0].context.metadata.httpStatusCode, 500);
  assert.deepEqual(calls[0].context.metadata.additionalCaughtErrors, ['Error: fallback also failed']);
});

test('buffered caught exceptions are NOT reported when the request succeeds', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(200);

  instance.requestHandler()(req, res, () => {
    (instance as any)._recordCaughtException(new Error('recovered gracefully'), { uncaught: false, frameUrl: '/app/routes.js' });
  });
  res.emit('finish');

  assert.equal(calls.length, 0, 'the code recovered — nothing to report');
});

test("report: 'always' policy captures caught exceptions immediately as warnings", () => {
  _resetForTests();
  const instance = new VantaTrace({
    apiKey: '',
    debug: false,
    autoCapture: { caughtExceptions: { report: 'always' } }
  });
  instance.shutdown(); // stop the real watcher; drive _recordCaughtException directly
  const calls = spyOnCapture(instance);

  const err = new Error('caught but interesting');
  (instance as any)._recordCaughtException(err, { uncaught: false, frameUrl: '/app/worker.js' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].error, err);
  assert.equal(calls[0].context.severity, 'warning');
  assert.equal(calls[0].context.metadata.captureStrategy, 'caughtException');
  assert.equal(calls[0].context.metadata.throwSite, '/app/worker.js');
});

test('exceptions predicted uncaught are skipped by the recorder (handled by global handlers)', () => {
  _resetForTests();
  const instance = new VantaTrace({
    apiKey: '',
    debug: false,
    autoCapture: { caughtExceptions: { report: 'always' } }
  });
  instance.shutdown();
  const calls = spyOnCapture(instance);

  (instance as any)._recordCaughtException(new Error('will crash anyway'), { uncaught: true, frameUrl: '/app/x.js' });

  assert.equal(calls.length, 0);
});

test('end-to-end: inspector watcher + Express-style flow captures a swallowed ReferenceError on a 500', () => {
  _resetForTests();
  const instance = new VantaTrace({
    apiKey: '',
    debug: false,
    autoCapture: { caughtExceptions: true }
  });
  // The watcher's default selfDir filter covers the SDK sources — which is also
  // where this test file lives. Rebuild it with an inert selfDir for the test.
  instance.shutdown();
  const { startCaughtExceptionWatcher } = require('./caught-exceptions');
  const stopWatcher = startCaughtExceptionWatcher(
    (error: any, info: any) => (instance as any)._recordCaughtException(error, info),
    { includeNodeModules: false, maxPerMinute: 1000, debug: false, selfDir: '/vantatrace-nonexistent' }
  );
  assert.ok(stopWatcher);

  try {
    const calls = spyOnCapture(instance);
    const { req, res } = fakeReqRes(500);

    instance.requestHandler()(req, res, () => {
      try {
        // @ts-expect-error intentional undefined reference — the user's exact scenario
        a;
      } catch (error) {
        res.statusCode = 500; // res.status(500).json(...) equivalent
      }
    });
    res.emit('finish');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].error.name, 'ReferenceError');
    assert.match(calls[0].error.message, /a is not defined/);
    assert.equal(calls[0].context.metadata.captureStrategy, 'caughtException');
    assert.equal(calls[0].context.metadata.httpStatusCode, 500);
  } finally {
    stopWatcher!();
  }
});

test('the synthetic HttpServerError includes the response body actually sent to the client', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);
  withJsonSend(res);

  instance.requestHandler()(req, res, () => {
    res.json({ error: 'Order failed' });
  });
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context.metadata.responseBody, { error: 'Order failed' });
});

test('a buffered caught exception also carries the response body sent to the client', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);
  withJsonSend(res);

  instance.requestHandler()(req, res, () => {
    (instance as any)._recordCaughtException(new ReferenceError('a is not defined'), { uncaught: false, frameUrl: '/app/routes.js' });
    res.json({ error: 'Order failed' });
  });
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.metadata.captureStrategy, 'caughtException');
  assert.deepEqual(calls[0].context.metadata.responseBody, { error: 'Order failed' });
});

test('response body capture is a no-op when res has no json/send (never throws)', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500); // no res.json/res.send — matches the pre-existing tests' fake res

  instance.requestHandler()(req, res, () => {});
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.metadata.responseBody, undefined);
});

test('the synthetic HttpServerError message nudges toward autoCapture.caughtExceptions when it is not enabled', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false }); // caughtExceptions not enabled
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);

  instance.requestHandler()(req, res, () => {});
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.match(calls[0].error.message, /autoCapture\.caughtExceptions/);
});

test('the synthetic HttpServerError message omits the hint when the watcher is already enabled', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false, autoCapture: { caughtExceptions: true } });
  const calls = spyOnCapture(instance);
  const { req, res } = fakeReqRes(500);

  try {
    instance.requestHandler()(req, res, () => {});
    res.emit('finish');

    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].error.message, /autoCapture\.caughtExceptions/);
  } finally {
    instance.shutdown();
  }
});

// These two tests inspect the AsyncLocalStorage store requestHandler() builds
// directly (rather than what's passed to captureException, which is only the
// explicit second argument a caller provides — auto-extracted request fields
// like query/body/metadata live on the store itself and get merged in later).
test('sensitive query-string keys are redacted the same way request-body keys are', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200, { query: { token: 'abc123', page: '2' } });

  let capturedQuery: any;
  instance.requestHandler()(req, res, () => {
    capturedQuery = (VantaTrace as any).asyncLocalStorage.getStore().query;
  });

  assert.equal(capturedQuery.token, '[REDACTED]');
  assert.equal(capturedQuery.page, '2');
});

test('auto-captured request context no longer duplicates query/body under metadata (they live at context.query/context.body)', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200, { query: { page: '2' } });
  req.body = { name: 'ok' };

  let store: any;
  instance.requestHandler()(req, res, () => {
    store = (VantaTrace as any).asyncLocalStorage.getStore();
  });

  assert.deepEqual(store.query, { page: '2' });
  assert.deepEqual(store.body, { name: 'ok' });
  assert.deepEqual(store.metadata, {});
});

// The following tests read the ALS store directly (see the note on the two
// tests above) since msisdn/userId are auto-extracted request fields, not
// something a caller passes to captureException() explicitly.
function storeFromRequest(instance: VantaTrace, req: any, res: any): any {
  let store: any;
  instance.requestHandler()(req, res, () => {
    store = (VantaTrace as any).asyncLocalStorage.getStore();
  });
  return store;
}

test('msisdn is read from the X-MSISDN header via req.get()', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.get = (name: string) => (name.toLowerCase() === 'x-msisdn' ? '+1 (415) 555-2671' : undefined);

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.msisdn, '+14155552671');
});

test('msisdn falls back to a plain x-msisdn header when req.get is unavailable', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.headers['x-msisdn'] = '923001234567';

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.msisdn, '923001234567');
});

test('msisdn is read from req.user.phone / mobilephone when no header is present', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });

  const { req: req1, res: res1 } = fakeReqRes(200);
  req1.user = { id: 'u1', phone: '+14155552671' };
  assert.equal(storeFromRequest(instance, req1, res1).msisdn, '+14155552671');

  const { req: req2, res: res2 } = fakeReqRes(200);
  req2.user = { id: 'u1', mobilephone: '+14155552671' };
  assert.equal(storeFromRequest(instance, req2, res2).msisdn, '+14155552671');
});

test('a value that does not look like a phone number is dropped, not forwarded', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.user = { id: 'u1', phone: 'not-a-phone-number' };

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.msisdn, undefined);
});

test('userId falls back to req.userId even when req.user exists but has no id fields', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.user = { email: 'user@example.com' }; // no id/_id/userId on req.user itself
  req.userId = 'fallback-id-123';

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.userId, 'fallback-id-123');
});

test('userId prefers req.user._id when req.user.id is absent', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.user = { _id: 'mongo-object-id' };

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.userId, 'mongo-object-id');
});

test('an X-MPIN header is redacted before it ever leaves requestHandler(), not just at the backend', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.get = (name: string) => (name.toLowerCase() === 'x-mpin' ? '1234' : undefined);
  req.headers['x-mpin'] = '1234'; // also present as a plain header, as it would be over HTTP

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.headers['x-mpin'], '[REDACTED]');
});

test('other sensitive-shaped headers (auth, cookies, api keys) are still redacted after the refactor', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.headers = {
    authorization: 'Bearer secret-token',
    cookie: 'session=abc123',
    'x-api-key': 'ep_live_abc',
    'x-request-id': 'req-1', // not sensitive — should pass through untouched
  };

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.headers.authorization, '[REDACTED]');
  assert.equal(store.headers.cookie, '[REDACTED]');
  assert.equal(store.headers['x-api-key'], '[REDACTED]');
  assert.equal(store.headers['x-request-id'], 'req-1');
});

test('app version is captured from the X-APP-VERSION header via req.get()', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.get = (name: string) => (name.toLowerCase() === 'x-app-version' ? '2.4.1' : undefined);

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.appVersion, '2.4.1');
});

test('app version falls back to a plain x-app-version header when req.get is unavailable', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const { req, res } = fakeReqRes(200);
  req.headers['x-app-version'] = '3.0.0-beta.2';

  const store = storeFromRequest(instance, req, res);
  assert.equal(store.appVersion, '3.0.0-beta.2');
});
