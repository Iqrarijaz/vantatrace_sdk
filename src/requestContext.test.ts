import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestContext } from './requestContext';

function fakeReq(overrides: any = {}): any {
  return {
    method: 'GET',
    path: '/orders',
    url: '/orders',
    headers: {},
    ...overrides
  };
}

const genTraceId = () => 'generated-trace-id';

test('extracts userId from req.userId when req.user is absent', () => {
  const ctx = buildRequestContext(fakeReq({ userId: 'u-1' }), genTraceId);
  assert.equal(ctx.userId, 'u-1');
  assert.deepEqual(ctx.user, { id: 'u-1' });
});

test('extracts userId/userInfo from req.user, preferring id over _id/userId variants', () => {
  const ctx = buildRequestContext(
    fakeReq({ user: { id: 'u-2', _id: 'u-legacy', email: 'a@b.com', role: 'admin', tenantId: 't-1' } }),
    genTraceId
  );
  assert.equal(ctx.userId, 'u-2');
  assert.deepEqual(ctx.user, { id: 'u-2', email: 'a@b.com', role: 'admin', tenantId: 't-1', orgId: undefined });
});

test('falls back through _id, then userId, then req.userId when req.user has no id', () => {
  const ctx = buildRequestContext(fakeReq({ user: { _id: 'u-legacy' } }), genTraceId);
  assert.equal(ctx.userId, 'u-legacy');
});

test('userInfo and userId are both undefined when there is no identity information at all', () => {
  const ctx = buildRequestContext(fakeReq(), genTraceId);
  assert.equal(ctx.userId, undefined);
  assert.equal(ctx.user, undefined);
});

test('resolves tenantId/orgId from their snake_case and alternate-name variants', () => {
  const ctx = buildRequestContext(
    fakeReq({ user: { id: 'u-3', tenant_id: 't-2', organizationId: 'org-1' } }),
    genTraceId
  );
  assert.equal(ctx.user.tenantId, 't-2');
  assert.equal(ctx.user.orgId, 'org-1');
});

test('extracts a valid MSISDN from the X-MSISDN header via req.get()', () => {
  const req = fakeReq({ get: (name: string) => (name === 'X-MSISDN' ? '+92 300 1234567' : undefined) });
  const ctx = buildRequestContext(req, genTraceId);
  assert.equal(ctx.msisdn, '+923001234567');
});

test('falls back to the lowercase x-msisdn header when req.get is unavailable', () => {
  const ctx = buildRequestContext(fakeReq({ headers: { 'x-msisdn': '03001234567' } }), genTraceId);
  assert.equal(ctx.msisdn, '03001234567');
});

test('falls back to req.user phone-shaped fields when no header is present', () => {
  const ctx = buildRequestContext(fakeReq({ user: { phone: '+923001234567' } }), genTraceId);
  assert.equal(ctx.msisdn, '+923001234567');
});

test('rejects an msisdn-shaped value that does not actually look like a phone number', () => {
  const ctx = buildRequestContext(fakeReq({ headers: { 'x-msisdn': 'not-a-phone-number' } }), genTraceId);
  assert.equal(ctx.msisdn, undefined);
});

test('rejects an msisdn candidate that is too short or too long after cleaning', () => {
  assert.equal(buildRequestContext(fakeReq({ headers: { 'x-msisdn': '12345' } }), genTraceId).msisdn, undefined);
  assert.equal(
    buildRequestContext(fakeReq({ headers: { 'x-msisdn': '1'.repeat(16) } }), genTraceId).msisdn,
    undefined
  );
});

test('redacts sensitive-looking keys (password/token/secret/auth/pin/creditcard/cvv/cookie/api-key) in the body', () => {
  const ctx = buildRequestContext(
    fakeReq({
      body: {
        username: 'ali',
        password: 'hunter2',
        authToken: 'abc',
        mpin: '1234',
        creditCardNumber: '4111111111111111',
        cvv: '123',
        sessionCookie: 'xyz',
        'x-api-key': 'k-1'
      }
    }),
    genTraceId
  );
  assert.equal(ctx.body.username, 'ali');
  assert.equal(ctx.body.password, '[REDACTED]');
  assert.equal(ctx.body.authToken, '[REDACTED]');
  assert.equal(ctx.body.mpin, '[REDACTED]');
  assert.equal(ctx.body.creditCardNumber, '[REDACTED]');
  assert.equal(ctx.body.cvv, '[REDACTED]');
  assert.equal(ctx.body.sessionCookie, '[REDACTED]');
  assert.equal(ctx.body['x-api-key'], '[REDACTED]');
});

test('redacts sensitive-looking keys in the query string the same way as the body', () => {
  const ctx = buildRequestContext(fakeReq({ query: { page: '2', token: 'secret-value' } }), genTraceId);
  assert.equal(ctx.query.page, '2');
  assert.equal(ctx.query.token, '[REDACTED]');
});

test('leaves body/query undefined when the request has none', () => {
  const ctx = buildRequestContext(fakeReq(), genTraceId);
  assert.equal(ctx.body, undefined);
  assert.equal(ctx.query, undefined);
});

test('redacts sensitive-looking header names, including an X-MPIN header, without mutating other headers', () => {
  const ctx = buildRequestContext(
    fakeReq({ headers: { 'x-mpin': '4821', 'content-type': 'application/json', authorization: 'Bearer abc' } }),
    genTraceId
  );
  assert.equal(ctx.headers['x-mpin'], '[REDACTED]');
  assert.equal(ctx.headers['authorization'], '[REDACTED]');
  assert.equal(ctx.headers['content-type'], 'application/json');
});

test('extracts geo fields from ip/cf-ipcountry/x-region/x-city headers', () => {
  const ctx = buildRequestContext(
    fakeReq({
      ip: '203.0.113.5',
      headers: { 'cf-ipcountry': 'PK', 'x-region': 'Punjab', 'x-city': 'Lahore' }
    }),
    genTraceId
  );
  assert.deepEqual(ctx.geo, { ip: '203.0.113.5', country: 'PK', region: 'Punjab', city: 'Lahore' });
  assert.equal(ctx.ip, '203.0.113.5');
});

test('falls back to the x-forwarded-for header and then the socket remoteAddress for ip', () => {
  const viaForwarded = buildRequestContext(
    fakeReq({ headers: { 'x-forwarded-for': '198.51.100.9' } }),
    genTraceId
  );
  assert.equal(viaForwarded.ip, '198.51.100.9');

  const viaSocket = buildRequestContext(fakeReq({ socket: { remoteAddress: '198.51.100.10' } }), genTraceId);
  assert.equal(viaSocket.ip, '198.51.100.10');
});

test('extracts and trims/caps the app version from X-APP-VERSION', () => {
  const ctx = buildRequestContext(
    fakeReq({ get: (name: string) => (name === 'X-APP-VERSION' ? '  2.3.0  ' : undefined) }),
    genTraceId
  );
  assert.equal(ctx.appVersion, '2.3.0');
});

test('caps an excessively long app version string at 64 characters', () => {
  const longVersion = 'v'.repeat(200);
  const ctx = buildRequestContext(fakeReq({ headers: { 'x-app-version': longVersion } }), genTraceId);
  assert.equal(ctx.appVersion.length, 64);
});

test('extracts sessionId, correlationId, and featureFlags with their fallback chains', () => {
  const ctx = buildRequestContext(
    fakeReq({
      headers: { 'x-request-id': 'req-1' },
      featureFlags: { newCheckout: true }
    }),
    genTraceId
  );
  assert.equal(ctx.correlationId, 'req-1');
  assert.deepEqual(ctx.featureFlags, { newCheckout: true });
});

test('prefers req.sessionID over session.id and the x-session-id header', () => {
  const ctx = buildRequestContext(
    fakeReq({ sessionID: 'sess-express', session: { id: 'sess-other' }, headers: { 'x-session-id': 'sess-header' } }),
    genTraceId
  );
  assert.equal(ctx.sessionId, 'sess-express');
});

test('continues an incoming W3C traceparent header instead of generating a new trace id', () => {
  const incoming = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const ctx = buildRequestContext(fakeReq({ headers: { traceparent: incoming } }), genTraceId);

  assert.equal(ctx.traceId, '0123456789abcdef0123456789abcdef');
  assert.equal(ctx.parentSpanId, '0123456789abcdef');
  assert.match(ctx.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(ctx.spanId, ctx.parentSpanId, 'a fresh span id must be generated for this hop');
  assert.equal(ctx.traceparent, `00-${ctx.traceId}-${ctx.spanId}-01`);
});

test('generates a new trace id when there is no incoming traceparent header', () => {
  const ctx = buildRequestContext(fakeReq(), genTraceId);
  assert.equal(ctx.traceId, 'generated-trace-id');
  assert.equal(ctx.parentSpanId, undefined);
  assert.equal(ctx.traceparent, `00-generated-trace-id-${ctx.spanId}-01`);
});

test('generates a new trace id when the incoming traceparent header is malformed', () => {
  const ctx = buildRequestContext(fakeReq({ headers: { traceparent: 'not-a-real-traceparent' } }), genTraceId);
  assert.equal(ctx.traceId, 'generated-trace-id');
  assert.equal(ctx.parentSpanId, undefined);
});

test('route falls back through req.route.path, then req.path, then req.url', () => {
  assert.equal(
    buildRequestContext(fakeReq({ route: { path: '/orders/:id' }, path: '/orders/5' }), genTraceId).route,
    '/orders/:id'
  );
  assert.equal(buildRequestContext(fakeReq({ path: '/orders/5' }), genTraceId).route, '/orders/5');
  assert.equal(
    buildRequestContext(fakeReq({ path: undefined, url: '/orders/5?x=1' }), genTraceId).route,
    '/orders/5?x=1'
  );
});

test('initializes metadata, breadcrumbs, and spans as empty and startTime as a real timestamp', () => {
  const before = Date.now();
  const ctx = buildRequestContext(fakeReq(), genTraceId);
  const after = Date.now();

  assert.deepEqual(ctx.metadata, {});
  assert.deepEqual(ctx.breadcrumbs, []);
  assert.deepEqual(ctx.spans, []);
  assert.ok(ctx.startTime >= before && ctx.startTime <= after);
});

test('keeps a reference to the original req object on the context', () => {
  const req = fakeReq();
  const ctx = buildRequestContext(req, genTraceId);
  assert.equal(ctx.req, req);
});
