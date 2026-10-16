import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishAutoCapture, AutoCaptureFinisherTarget } from './autoCaptureFinisher';
import { requestStorage } from './store';

function fakeTarget(overrides: Partial<AutoCaptureFinisherTarget> = {}): {
  target: AutoCaptureFinisherTarget;
  captureCalls: { error: any; context: any; storeAtCallTime: any }[];
} {
  const captureCalls: { error: any; context: any; storeAtCallTime: any }[] = [];
  const target: AutoCaptureFinisherTarget = {
    http5xxEnabled: true,
    http4xxEnabled: true,
    http4xxExclude: new Set([401, 404]),
    hasCaughtWatcher: false,
    captureException: (error, context) => {
      captureCalls.push({ error, context, storeAtCallTime: requestStorage.getStore() });
    },
    ...overrides
  };
  return { target, captureCalls };
}

function fakeStore(overrides: any = {}): any {
  return { method: 'GET', route: '/orders', ...overrides };
}

test('does nothing when the response never got a status code', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore(), { method: 'GET' }, {});
  assert.equal(captureCalls.length, 0);
});

test('does nothing for a successful (< 400) response', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore(), { method: 'GET' }, { statusCode: 200 });
  assert.equal(captureCalls.length, 0);
});

test('does nothing when a manual captureException already ran for this request', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore({ _vantaErrorCaptured: true }), { method: 'GET' }, { statusCode: 500 });
  assert.equal(captureCalls.length, 0);
});

test('a 5xx with no reported error emits a synthetic HttpServerError at critical severity', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore(), { method: 'POST', url: '/orders' }, { statusCode: 503 });

  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].error.name, 'HttpServerError');
  assert.match(captureCalls[0].error.message, /POST \/orders responded with HTTP 503/);
  assert.equal(captureCalls[0].context.severity, 'critical');
  assert.equal(captureCalls[0].context.metadata.captureStrategy, 'http5xx');
  assert.equal(captureCalls[0].context.metadata.httpStatusCode, 503);
});

test('a 4xx (not excluded) emits a synthetic HttpClientError at warning severity', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore(), { method: 'POST', url: '/orders' }, { statusCode: 400 });

  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].error.name, 'HttpClientError');
  assert.equal(captureCalls[0].context.severity, 'warning');
  assert.equal(captureCalls[0].context.metadata.captureStrategy, 'http4xx');
});

test('excluded 4xx status codes (401/404 by default) are never synthesized', () => {
  const { target, captureCalls } = fakeTarget();
  for (const status of [401, 404]) {
    finishAutoCapture(target, fakeStore(), {}, { statusCode: status });
  }
  assert.equal(captureCalls.length, 0);
});

test('http4xxExclude is configurable and fully replaces the default exclusion set', () => {
  const { target, captureCalls } = fakeTarget({ http4xxExclude: new Set([400]) });
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 400 });
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 401 });

  assert.equal(captureCalls.length, 1, 'only 401 (no longer excluded) should synthesize');
  assert.equal(captureCalls[0].context.metadata.httpStatusCode, 401);
});

test('http5xxEnabled: false suppresses the synthetic 5xx capture', () => {
  const { target, captureCalls } = fakeTarget({ http5xxEnabled: false });
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 500 });
  assert.equal(captureCalls.length, 0);
});

test('http4xxEnabled: false suppresses the synthetic 4xx capture', () => {
  const { target, captureCalls } = fakeTarget({ http4xxEnabled: false });
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 422 });
  assert.equal(captureCalls.length, 0);
});

test('a buffered caught exception is reported as the root cause instead of a synthetic error', () => {
  const { target, captureCalls } = fakeTarget();
  const rootCause = new ReferenceError('a is not defined');
  finishAutoCapture(target, fakeStore({ _vantaCaughtErrors: [rootCause] }), {}, { statusCode: 500 });

  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].error, rootCause);
  assert.equal(captureCalls[0].context.metadata.captureStrategy, 'caughtException');
  assert.equal(captureCalls[0].context.metadata.handled, true);
  assert.equal(captureCalls[0].context.metadata.additionalCaughtErrors, undefined);
});

test('caught exceptions are reported even when the matching category is disabled', () => {
  const { target, captureCalls } = fakeTarget({ http5xxEnabled: false });
  const rootCause = new Error('swallowed failure');
  finishAutoCapture(target, fakeStore({ _vantaCaughtErrors: [rootCause] }), {}, { statusCode: 500 });

  assert.equal(captureCalls.length, 1, 'a real caught exception outranks the enable/disable flag');
  assert.equal(captureCalls[0].error, rootCause);
});

test('multiple buffered caught exceptions: the first is the root cause, the rest are summarized', () => {
  const { target, captureCalls } = fakeTarget();
  const primary = new Error('primary failure');
  const secondary = new TypeError('cascade failure');
  finishAutoCapture(target, fakeStore({ _vantaCaughtErrors: [primary, secondary] }), {}, { statusCode: 500 });

  assert.equal(captureCalls[0].error, primary);
  assert.deepEqual(captureCalls[0].context.metadata.additionalCaughtErrors, ['TypeError: cascade failure']);
});

test('excluded 4xx codes suppress caught-exception reporting too, not just synthesis', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore({ _vantaCaughtErrors: [new Error('ignored')] }), {}, { statusCode: 404 });
  assert.equal(captureCalls.length, 0);
});

test('includes the captured response body in metadata when present', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore({ _vantaResponseBody: { error: 'Order failed' } }), {}, { statusCode: 500 });

  assert.deepEqual(captureCalls[0].context.metadata.responseBody, { error: 'Order failed' });
});

test('omits responseBody from metadata entirely when none was recorded', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 500 });

  assert.equal('responseBody' in captureCalls[0].context.metadata, false);
});

test('includes a hint to enable autoCapture.caughtExceptions when the watcher is not already running', () => {
  const { target, captureCalls } = fakeTarget({ hasCaughtWatcher: false });
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 500 });
  assert.match(captureCalls[0].error.message, /Enable autoCapture\.caughtExceptions/);
});

test('omits the hint when the caught-exception watcher is already running', () => {
  const { target, captureCalls } = fakeTarget({ hasCaughtWatcher: true });
  finishAutoCapture(target, fakeStore(), {}, { statusCode: 500 });
  assert.doesNotMatch(captureCalls[0].error.message, /Enable autoCapture\.caughtExceptions/);
});

test('falls back to the request/store method and route when req is missing them', () => {
  const { target, captureCalls } = fakeTarget();
  finishAutoCapture(target, fakeStore({ method: 'PATCH', route: '/legacy-route' }), {}, { statusCode: 500 });
  assert.match(captureCalls[0].error.message, /PATCH \/legacy-route/);
});

test('re-enters the request\'s AsyncLocalStorage context so captureException sees the enriching store', () => {
  const { target, captureCalls } = fakeTarget();
  const store = fakeStore();
  finishAutoCapture(target, store, {}, { statusCode: 500 });

  assert.equal(captureCalls[0].storeAtCallTime, store);
});

test('never throws even if a bad target/store shape causes an internal error', () => {
  const { target } = fakeTarget({ http4xxExclude: undefined as any });
  assert.doesNotThrow(() => {
    finishAutoCapture(target, fakeStore(), {}, { statusCode: 400 });
  });
});
