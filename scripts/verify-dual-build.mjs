#!/usr/bin/env node
/**
 * Smoke-tests both the CJS and ESM builds in dist/ after `tsup` runs.
 *
 * This exists because the dual build has one specific, easy-to-silently-
 * reintroduce failure mode: esbuild's ESM output rewrites every bare
 * `require` identifier reference (including inside code trying to detect
 * whether a real `require` exists) to its own interop shim, which throws
 * "Dynamic require of ... is not supported" when actually invoked. That
 * failure is swallowed by this SDK's own fail-silent try/catch around
 * optional-dependency detection — so a regression here doesn't crash
 * anything, it just silently stops instrumenting outbound HTTP calls
 * (breadcrumbs, spans, trace-context propagation) in the ESM build, with
 * zero visible error. A plain "does it import without throwing" check
 * would not catch that. This checks the actual patch took effect.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

async function verifyEsm() {
  const httpModule = await import('http');
  const before = httpModule.default.request;
  const { VantaTrace } = await import('../dist/index.mjs');
  new VantaTrace({ apiKey: '', debug: false });
  assert.notEqual(httpModule.default.request, before, 'ESM build: http.request was not patched');
}

function verifyCjs() {
  const http = require('http');
  const before = http.request;
  const { VantaTrace } = require('../dist/index.js');
  new VantaTrace({ apiKey: '', debug: false });
  assert.notEqual(http.request, before, 'CJS build: http.request was not patched');
}

try {
  verifyCjs();
  console.log('✓ CJS build: http/https instrumentation patches correctly');
} catch (err) {
  console.error('✗ CJS build verification failed:', err.message);
  process.exitCode = 1;
}

try {
  await verifyEsm();
  console.log('✓ ESM build: http/https instrumentation patches correctly');
} catch (err) {
  console.error('✗ ESM build verification failed:', err.message);
  process.exitCode = 1;
}

if (process.exitCode) {
  console.error('\nDual-build verification failed — see tsup.config.ts / src/nodeRequire.ts.');
} else {
  console.log('\nDual-build verification passed.');
}
