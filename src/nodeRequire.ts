import { createRequire } from 'module';

/**
 * True in the ESM build, false in the CJS build — a compile-time constant
 * injected by tsup (see tsup.config.ts), not a runtime check. A runtime
 * `typeof require` check can't tell the two build targets apart from
 * inside this file: esbuild's ESM output transform rewrites *every* bare
 * `require` identifier reference to its own interop shim, including inside
 * code that's trying to detect whether a real `require` exists — so by the
 * time this ran, the check would always see esbuild's shim, never "there is
 * truly no require here." Only a build-time constant, resolved and
 * dead-code-eliminated before that substitution pass runs, actually works.
 *
 * Outside a tsup build (e.g. tests run directly via `tsx`, with no `define`
 * injected at all) the identifier plain doesn't exist — `typeof` is the
 * only safe way to check that without throwing a ReferenceError — so this
 * falls back to a genuine runtime check, which is accurate in that context
 * since tsx runs the file as real CommonJS, unaffected by esbuild's
 * format-conversion interop shimming.
 */
declare const __VANTA_ESM__: boolean;
const isEsmBuild: boolean =
  typeof __VANTA_ESM__ !== 'undefined' ? __VANTA_ESM__ : typeof require === 'undefined';

/**
 * A `require()` that works in both the CommonJS and ESM builds of this
 * package. Needed for optional peer-dependency detection (pg, mysql2,
 * ioredis, winston, pino, winston-transport) and for monkey-patching Node
 * core modules (http, https) that must resolve to the real shared
 * singleton — that stays a synchronous `try { require(x) } catch`, rather
 * than switching to async dynamic `import()`, because instrumentation setup
 * happens in the constructor and an async version would race against
 * requests arriving immediately after `new VantaTrace(...)` returns.
 *
 * The ESM branch anchors `createRequire` at the process entry script
 * (`process.argv[1]`), not `import.meta.url` — esbuild replaces
 * `import.meta` with an empty object when targeting CJS output, so a
 * shared source file using it directly breaks the CJS build instead.
 * Anchoring at the entry script instead of this exact file's own location
 * is fine here: every name ever passed to `dynamicRequire()` is either a
 * Node core module (resolves from any anchor) or a bare package name Node
 * resolves by walking up through `node_modules` from the anchor — which
 * the host application's own entry point is squarely inside.
 */
function getRequire(): NodeRequire {
  if (!isEsmBuild) {
    return require;
  }
  return createRequire(process.argv[1] || `${process.cwd()}/`);
}

export const dynamicRequire: NodeRequire = getRequire();
