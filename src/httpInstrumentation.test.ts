import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { patchHttp, HttpInstrumentationTarget } from './httpInstrumentation';
import { requestStorage } from './store';
import { dynamicRequire } from './nodeRequire';

// Must use dynamicRequire (not `import * as http from 'http'`) to get the exact
// same object patchHttp() itself mutates — esbuild/tsx's ESM-namespace-import
// interop copies properties onto a synthetic object rather than returning the
// real module.exports singleton, so a plain namespace import here would patch
// a copy nobody else ever reads. Same pitfall documented in nodeRequire.ts.
const http: any = dynamicRequire('http');
const https: any = dynamicRequire('https');

/**
 * Replaces http.request/https.request with recording mocks (so no real
 * socket is ever opened), applies patchHttp() on top of those mocks, runs
 * `run`, then restores the true originals — patchHttp mutates the shared
 * module singletons, so a leaked patch would affect every other test file
 * that happens to make a real outbound request.
 */
function withPatchedHttp(
  target: HttpInstrumentationTarget,
  run: (calls: { module: 'http' | 'https'; options: any }[]) => void
): void {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const calls: { module: 'http' | 'https'; options: any }[] = [];

  http.request = (options: any, ..._args: any[]) => {
    calls.push({ module: 'http', options });
    return new EventEmitter();
  };
  https.request = (options: any, ..._args: any[]) => {
    calls.push({ module: 'https', options });
    return new EventEmitter();
  };

  patchHttp(target);
  try {
    run(calls);
  } finally {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  }
}

function fakeTarget(overrides: Partial<HttpInstrumentationTarget> = {}): {
  target: HttpInstrumentationTarget;
  breadcrumbCalls: any[];
  spanStarts: { type: string; name: string }[];
} {
  const breadcrumbCalls: any[] = [];
  const spanStarts: { type: string; name: string }[] = [];
  const target: HttpInstrumentationTarget = {
    apiUrl: 'https://ingest.vantatrace.com/api/events',
    addBreadcrumb: (breadcrumb) => { breadcrumbCalls.push(breadcrumb); },
    startSpan: (type, name) => {
      spanStarts.push({ type, name });
      return { end: () => {} };
    },
    ...overrides
  };
  return { target, breadcrumbCalls, spanStarts };
}

test('a non-self outbound request records an http breadcrumb with method and url', () => {
  const { target, breadcrumbCalls } = fakeTarget();
  withPatchedHttp(target, (calls) => {
    http.request({ hostname: 'other.example.com', path: '/foo', method: 'GET' });

    assert.equal(breadcrumbCalls.length, 1);
    assert.equal(breadcrumbCalls[0].category, 'http');
    assert.equal(breadcrumbCalls[0].message, 'GET http://other.example.com/foo');
    assert.deepEqual(breadcrumbCalls[0].data, { method: 'GET', url: 'http://other.example.com/foo' });
    assert.equal(calls.length, 1);
  });
});

test('an https request without an explicit protocol defaults to an https:// url in the breadcrumb', () => {
  const { target, breadcrumbCalls } = fakeTarget();
  withPatchedHttp(target, () => {
    https.request({ hostname: 'other.example.com', path: '/z', method: 'GET' });

    assert.equal(breadcrumbCalls[0].message, 'GET https://other.example.com/z');
  });
});

test('a self-telemetry request (host matches apiUrl) is excluded: no breadcrumb, no span, options untouched', () => {
  const { target, breadcrumbCalls, spanStarts } = fakeTarget({ apiUrl: 'https://ingest.vantatrace.com/api/events' });
  withPatchedHttp(target, (calls) => {
    const options = { hostname: 'ingest.vantatrace.com', path: '/api/events', method: 'POST' };
    https.request(options);

    assert.equal(breadcrumbCalls.length, 0);
    assert.equal(spanStarts.length, 0);
    assert.equal(calls[0].options, options, 'self-telemetry calls must pass the original options through unmodified');
  });
});

test('injects the active request\'s traceparent header into an outbound request that does not already set one', () => {
  const { target } = fakeTarget();
  withPatchedHttp(target, (calls) => {
    requestStorage.run({ traceparent: '00-aaaa-bbbb-01' } as any, () => {
      http.request({ hostname: 'other.example.com', path: '/', method: 'GET' });
    });

    assert.equal(calls[0].options.headers.traceparent, '00-aaaa-bbbb-01');
  });
});

test('never overwrites a traceparent header the caller already set', () => {
  const { target } = fakeTarget();
  withPatchedHttp(target, (calls) => {
    requestStorage.run({ traceparent: '00-store-value-01' } as any, () => {
      http.request({
        hostname: 'other.example.com',
        path: '/',
        method: 'GET',
        headers: { traceparent: 'caller-set-value' }
      });
    });

    assert.equal(calls[0].options.headers.traceparent, 'caller-set-value');
  });
});

test('does not inject a traceparent header when there is no active request context', () => {
  const { target } = fakeTarget();
  withPatchedHttp(target, (calls) => {
    http.request({ hostname: 'other.example.com', path: '/', method: 'GET' });

    assert.equal(calls[0].options.headers, undefined);
  });
});

for (const event of ['response', 'error', 'close'] as const) {
  test(`ends the http span exactly once when the request emits '${event}'`, () => {
    let ends = 0;
    const { target, spanStarts } = fakeTarget({
      startSpan: (type, name) => {
        spanStarts.push({ type, name });
        return { end: () => { ends++; } };
      }
    });
    withPatchedHttp(target, () => {
      const req: any = http.request({ hostname: 'other.example.com', path: '/w', method: 'GET' });
      assert.equal(spanStarts.length, 1);
      req.emit(event);
      assert.equal(ends, 1);
    });
  });
}

test('a request made with a plain URL string still records a breadcrumb without crashing', () => {
  const { target, breadcrumbCalls } = fakeTarget();
  withPatchedHttp(target, (calls) => {
    assert.doesNotThrow(() => {
      http.request('http://other.example.com/legacy-string-form');
    });

    assert.equal(breadcrumbCalls.length, 1);
    assert.match(breadcrumbCalls[0].message, /GET http:\/\/other\.example\.com\/legacy-string-form/);
    assert.equal(calls.length, 1);
  });
});
