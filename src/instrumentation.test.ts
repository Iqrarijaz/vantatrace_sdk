import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSqlQuery } from './instrumentation';

test('redacts single-quoted string literals', () => {
  const result = sanitizeSqlQuery("SELECT * FROM users WHERE cnic = '12345-1234567-1'");
  assert.equal(result, 'SELECT * FROM users WHERE cnic = ?');
});

test('redacts a password/PIN value passed as a string literal', () => {
  const result = sanitizeSqlQuery("UPDATE accounts SET mpin = '4821' WHERE msisdn = '+923001234567'");
  assert.doesNotMatch(result, /4821|923001234567/);
  assert.match(result, /mpin = \? WHERE msisdn = \?/);
});

test('redacts standalone numeric literals but leaves digits inside identifiers alone', () => {
  const result = sanitizeSqlQuery('SELECT * FROM table_v2 WHERE age = 25 AND id = 9001');
  assert.equal(result, 'SELECT * FROM table_v2 WHERE age = ? AND id = ?');
});

test('redacts hex literals', () => {
  const result = sanitizeSqlQuery('SELECT * FROM t WHERE token = 0x4F1A2B');
  assert.equal(result, 'SELECT * FROM t WHERE token = ?');
});

test('strips block comments', () => {
  const result = sanitizeSqlQuery('SELECT * FROM users /* internal note about secret_field */ WHERE id = 1');
  assert.doesNotMatch(result, /internal note/);
  assert.equal(result, 'SELECT * FROM users WHERE id = ?');
});

test('strips ANSI line comments', () => {
  const result = sanitizeSqlQuery('SELECT * FROM users -- fetch by cnic\nWHERE cnic = \'12345-1234567-1\'');
  assert.doesNotMatch(result, /fetch by cnic/);
  assert.doesNotMatch(result, /12345-1234567-1/);
});

test('strips MySQL # line comments', () => {
  const result = sanitizeSqlQuery('SELECT * FROM users # legacy column, ignore\nWHERE id = 1');
  assert.doesNotMatch(result, /legacy column/);
});

test('does not misread a comment-marker-shaped substring inside a string literal as a real comment', () => {
  const result = sanitizeSqlQuery("SELECT * FROM notes WHERE body = 'foo--bar'");
  assert.equal(result, 'SELECT * FROM notes WHERE body = ?');
});

test('a realistic multi-field fintech query has zero PII surviving', () => {
  const query = `
    INSERT INTO transactions (msisdn, cnic, amount, mpin, card_number)
    VALUES ('+923001234567', '61101-1234567-1', 5000, '9284', '4111111111111111')
  `;
  const result = sanitizeSqlQuery(query);
  assert.doesNotMatch(result, /923001234567|61101-1234567-1|9284|4111111111111111|5000/);
  assert.match(result, /VALUES \(\?, \?, \?, \?, \?\)/);
});

test('passes through non-string input unchanged', () => {
  assert.equal(sanitizeSqlQuery(undefined as any), undefined);
  assert.equal(sanitizeSqlQuery(null as any), null);
  assert.equal(sanitizeSqlQuery(''), '');
});

test('collapses whitespace left behind by stripped comments', () => {
  const result = sanitizeSqlQuery('SELECT 1 /* comment */ /* another */ FROM t');
  assert.equal(result, 'SELECT ? FROM t');
});
