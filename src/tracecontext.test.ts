import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTraceId, generateSpanId, parseTraceParent, buildTraceParent } from './tracecontext';

test('generateTraceId produces a 32-char lowercase hex string', () => {
  const id = generateTraceId();
  assert.match(id, /^[0-9a-f]{32}$/);
});

test('generateSpanId produces a 16-char lowercase hex string', () => {
  const id = generateSpanId();
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('generateTraceId/generateSpanId produce distinct values across calls', () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateTraceId()));
  assert.equal(ids.size, 20);
});

test('parseTraceParent parses a well-formed header', () => {
  const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  const parsed = parseTraceParent(header);
  assert.deepEqual(parsed, {
    version: '00',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    parentId: 'b7ad6b7169203331',
    flags: '01'
  });
});

test('parseTraceParent is case-insensitive on hex segments', () => {
  const header = '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01';
  const parsed = parseTraceParent(header);
  assert.equal(parsed?.traceId, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(parsed?.parentId, 'b7ad6b7169203331');
});

test('parseTraceParent trims surrounding whitespace', () => {
  const parsed = parseTraceParent('  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01  ');
  assert.ok(parsed);
});

test('parseTraceParent returns null for malformed headers', () => {
  assert.equal(parseTraceParent('not-a-traceparent'), null);
  assert.equal(parseTraceParent('00-tooshort-b7ad6b7169203331-01'), null);
  assert.equal(parseTraceParent('00-0af7651916cd43dd8448eb211c80319c-tooshort-01'), null);
  assert.equal(parseTraceParent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-zz'), null);
});

test('parseTraceParent returns null for an all-zero trace-id or parent-id (explicitly invalid per spec)', () => {
  assert.equal(parseTraceParent('00-00000000000000000000000000000000-b7ad6b7169203331-01'), null);
  assert.equal(parseTraceParent('00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'), null);
});

test('parseTraceParent never throws on non-string input', () => {
  assert.equal(parseTraceParent(undefined), null);
  assert.equal(parseTraceParent(null), null);
  assert.equal(parseTraceParent(123 as any), null);
});

test('buildTraceParent produces a well-formed header defaulting to sampled (01)', () => {
  const header = buildTraceParent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331');
  assert.equal(header, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
});

test('buildTraceParent accepts a custom flags value', () => {
  const header = buildTraceParent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331', '00');
  assert.equal(header, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
});

test('round-trips: a built traceparent parses back to the same trace/parent IDs', () => {
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  const header = buildTraceParent(traceId, spanId);
  const parsed = parseTraceParent(header);
  assert.equal(parsed?.traceId, traceId);
  assert.equal(parsed?.parentId, spanId);
});
