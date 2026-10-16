import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasker } from './masking';

test('redacts built-in default sensitive keys', () => {
  const mask = createMasker();
  const result = mask({ username: 'ali', password: 'hunter2', mpin: '1234' });
  assert.equal(result.username, 'ali');
  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.mpin, '[REDACTED]');
});

test('redacts custom project-supplied keys (exact match, case-insensitive)', () => {
  const mask = createMasker(['CNIC', 'ConsumerName', 'BankAccountNumber']);
  const result = mask({
    cnic: '12345-1234567-1',
    ConsumerName: 'Jane Doe',
    bankaccountnumber: '1234567890',
    orderId: 'ORD-1'
  });
  assert.equal(result.cnic, '[REDACTED]');
  assert.equal(result.ConsumerName, '[REDACTED]');
  assert.equal(result.bankaccountnumber, '[REDACTED]');
  assert.equal(result.orderId, 'ORD-1');
});

test('recurses into nested objects and arrays', () => {
  const mask = createMasker(['cnic']);
  const result = mask({
    order: {
      customer: { name: 'Ali', cnic: '12345-1234567-1' },
      items: [{ sku: 'A1', pin: '0000' }]
    }
  });
  assert.equal(result.order.customer.name, 'Ali');
  assert.equal(result.order.customer.cnic, '[REDACTED]');
  assert.equal(result.order.items[0].sku, 'A1');
  assert.equal(result.order.items[0].pin, '[REDACTED]');
});

test('passes through primitives, null, undefined, Date, and Error untouched', () => {
  const mask = createMasker();
  assert.equal(mask('plain string'), 'plain string');
  assert.equal(mask(42), 42);
  assert.equal(mask(null), null);
  assert.equal(mask(undefined), undefined);

  const date = new Date();
  assert.equal(mask(date), date);

  const err = new Error('boom');
  assert.equal(mask(err), err);
});

test('caps recursion depth instead of stack-overflowing on pathological input', () => {
  const mask = createMasker();
  let deep: any = { password: 'leaf' };
  for (let i = 0; i < 20; i++) {
    deep = { nested: deep };
  }
  const result = mask(deep);
  assert.equal(typeof result, 'object');
});

test('an unmasked object is unaffected by an empty custom key list', () => {
  const mask = createMasker([]);
  const result = mask({ orderId: 'ORD-1', amount: 500 });
  assert.deepEqual(result, { orderId: 'ORD-1', amount: 500 });
});
