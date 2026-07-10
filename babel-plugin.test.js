const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('@babel/core');
const path = require('node:path');

const PLUGIN_PATH = path.join(__dirname, 'babel-plugin.js');

function run(code, sourceType) {
  const result = transform(code, {
    plugins: [PLUGIN_PATH],
    sourceType,
    filename: sourceType === 'module' ? 'test.mjs' : 'test.js',
    babelrc: false,
    configFile: false
  });
  return result.code;
}

test('injects an ESM import and capture call into a simple catch block', () => {
  const input = [
    "import express from 'express';",
    'try {',
    '  doSomething();',
    '} catch (err) {',
    '  handle(err);',
    '}'
  ].join('\n');

  const output = run(input, 'module');

  assert.match(output, /from "@vantatrace\/sdk\/runtime"/);
  assert.match(output, /captureExceptionGlobal\w*\(err\)/);
});

test('injects only one ESM import for multiple catch blocks in the same file', () => {
  const input = [
    "import express from 'express';",
    'try { a(); } catch (err) { h1(err); }',
    'try { b(); } catch (err2) { h2(err2); }'
  ].join('\n');

  const output = run(input, 'module');

  const importMatches = output.match(/from "@vantatrace\/sdk\/runtime"/g) || [];
  assert.equal(importMatches.length, 1);
});

test('injects a require() and capture call into a CommonJS file, only once for multiple catches', () => {
  const input = [
    "const express = require('express');",
    'try {',
    '  a();',
    '} catch (err) {',
    '  handleA(err);',
    '}',
    'try {',
    '  b();',
    '} catch (err2) {',
    '  handleB(err2);',
    '}'
  ].join('\n');

  const output = run(input, 'script');

  const requireMatches = output.match(/require\("@vantatrace\/sdk\/runtime"\)/g) || [];
  assert.equal(requireMatches.length, 1);
  assert.match(output, /\(err\)/);
  assert.match(output, /\(err2\)/);
});

test('skips catch blocks with no binding', () => {
  const output = run('try { a(); } catch { b(); }', 'script');
  assert.doesNotMatch(output, /captureExceptionGlobal/);
  assert.doesNotMatch(output, /require\("@vantatrace\/sdk\/runtime"\)/);
});

test('skips catch blocks with a destructured binding', () => {
  const output = run('try { a(); } catch ({ message }) { b(message); }', 'script');
  assert.doesNotMatch(output, /captureExceptionGlobal/);
});

test('skips when // vantatrace-ignore precedes the try statement', () => {
  const input = [
    '// vantatrace-ignore',
    'try {',
    '  a();',
    '} catch (err) {',
    '  b(err);',
    '}'
  ].join('\n');
  const output = run(input, 'script');
  assert.doesNotMatch(output, /captureExceptionGlobal/);
});

test('does not treat an unrelated trailing comment on the previous statement as an ignore directive', () => {
  const input = [
    'logSomething(); // TODO: remove the vantatrace-ignore workaround later',
    'try {',
    '  a();',
    '} catch (err) {',
    '  b(err);',
    '}'
  ].join('\n');
  const output = run(input, 'script');
  assert.match(output, /captureExceptionGlobal/);
});

test('skips when // vantatrace-ignore is inline after the catch clause', () => {
  const input = [
    'try {',
    '  a();',
    '} catch (err) { // vantatrace-ignore',
    '  b(err);',
    '}'
  ].join('\n');
  const output = run(input, 'script');
  assert.doesNotMatch(output, /captureExceptionGlobal/);
});

test('skips when captureException is already called manually in the same catch block', () => {
  const input = [
    "const { vantaTrace } = require('./instrument');",
    'try {',
    '  a();',
    '} catch (err) {',
    '  vantaTrace.captureException(err);',
    '}'
  ].join('\n');
  const output = run(input, 'script');
  const requireMatches = output.match(/require\("@vantatrace\/sdk\/runtime"\)/g) || [];
  assert.equal(requireMatches.length, 0);
});

test('does NOT skip when the manual capture is only inside a nested unrelated catch block', () => {
  const input = [
    'try {',
    '  a();',
    '} catch (outerErr) {',
    '  try {',
    '    b();',
    '  } catch (innerErr) {',
    '    vantaTrace.captureException(innerErr);',
    '  }',
    '  cleanup();',
    '}'
  ].join('\n');
  const output = run(input, 'script');
  const requireMatches = output.match(/require\("@vantatrace\/sdk\/runtime"\)/g) || [];
  assert.equal(requireMatches.length, 1);
  assert.match(output, /\(outerErr\)/);
});
