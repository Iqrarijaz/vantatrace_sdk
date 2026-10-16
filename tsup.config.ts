import { defineConfig } from 'tsup';

// Peer/optional integrations (pg, mysql2, ioredis, winston, pino,
// winston-transport) and Node builtins accessed via require() at runtime
// must stay external/unbundled — bundling them would defeat the "only
// touches what's actually installed" design and would need each to become
// a hard dependency instead.
const external = ['pg', 'mysql2', 'ioredis', 'winston', 'winston-transport', 'pino'];

const entry = {
  index: 'src/index.ts',
  runtime: 'src/runtime.ts',
  fastify: 'src/fastify.ts',
  nestjs: 'src/nestjs.ts',
  // Loaded at runtime via `new Worker(path.join(__dirname, 'transportWorker.js'))`
  // (see src/transport.ts) rather than a static import, so tsup has no way to
  // discover it needs bundling unless it's listed here explicitly. Without
  // this, dist/transportWorker.js simply doesn't exist in the published
  // package and every Worker spawn fails with MODULE_NOT_FOUND — silently
  // falls back to in-process sending (see transport.ts's catch block), but
  // logs a scary "Worker thread crashed" line on every single process start.
  transportWorker: 'src/transportWorker.ts'
};

// Two separate build passes, not one with format: ['cjs', 'esm'] — the
// __VANTA_ESM__ compile-time constant (see src/nodeRequire.ts) needs a
// different literal value per format so esbuild's dead-code elimination
// strips the unreachable branch *before* bundling, rather than at runtime.
// This matters because esbuild's ESM output transform rewrites every bare
// `require` identifier reference to its own `__require` interop shim —
// including inside code that's trying to detect whether a real `require`
// exists — so a runtime `typeof require` check can't tell the two build
// targets apart from the inside; only a build-time constant can.
export default defineConfig([
  {
    entry,
    format: ['cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: 'node',
    target: 'node16',
    external,
    skipNodeModulesBundle: true,
    define: { __VANTA_ESM__: 'false' }
  },
  {
    entry,
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    platform: 'node',
    target: 'node16',
    external,
    skipNodeModulesBundle: true,
    define: { __VANTA_ESM__: 'true' }
  }
]);
