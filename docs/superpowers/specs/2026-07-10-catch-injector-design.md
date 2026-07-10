# Zero-Code Catch-Block Error Capture — Design

## Problem

Developers using `@vantatrace/sdk` must manually call `vantaTrace.captureException(error)`
inside every `try/catch` block. Forgotten calls mean silently swallowed errors. There is no
runtime hook for handled `catch` blocks, so this must be solved at build time via AST
transformation (Babel now, SWC later).

## Goal

Install and configure the SDK once in the app's entrypoint (`new VantaTrace(options)`,
as already documented). After that, every `catch` block in the codebase reports errors
automatically, with no further per-file import or call required.

## 1. Runtime singleton registry (SDK-side)

New files, no change to the public `new VantaTrace(options)` API:

- **`src/registry.ts`**
  - `registerGlobalInstance(instance: VantaTrace, debug: boolean): void` — first
    call wins. A later call (a second `new VantaTrace()`) logs
    `[VantaTrace] WARNING: multiple instances constructed; the first instance remains
    the global singleton used by auto-instrumented catch blocks.` unconditionally
    (not gated on `debug`), since it signals a likely misconfiguration.
  - `getGlobalInstance(): VantaTrace | null`
  - `captureExceptionGlobal(error: any, context?: VantaTraceContext): void` —
    resolves the singleton and forwards to `captureException`. If no instance is
    registered yet, logs a one-time (per-process) warning and no-ops. Injected code
    never needs a null check.
- **`src/index.ts`** — `VantaTrace` constructor calls
  `registerGlobalInstance(this, this.debug)` as its last statement.
- **`src/runtime.ts`** — re-exports only `captureExceptionGlobal` from `registry.ts`.
  This is the fixed import target injected code uses. It does not import `index.ts`,
  so referencing it doesn't pull in Express middleware, `AsyncLocalStorage`, or the
  Winston/Pino patchers.
- **`package.json`** — add an `exports` map:
  - `"."` → `dist/index.js` (existing main SDK)
  - `"./runtime"` → `dist/runtime.js`
  - `"./babel-plugin"` → `babel-plugin.js` (existing, unbundled — plain CJS, no
    build step needed since it only runs under Node/Babel, never shipped to
    browsers/consumers' bundles)

Existing dedup behavior in `captureException` (a `WeakSet` of already-reported
`Error` objects) means an injected catch-block capture and a later
`uncaughtException`/`unhandledRejection` capture of the same rethrown error object
are reported only once — no extra work needed here.

## 2. Babel plugin (`babel-plugin.js`)

Rewrites the existing draft. Behavior, per `CatchClause`:

1. **No binding** (`catch { }`, ES2019 optional catch) — skip. No error object
   exists to pass. Documented limitation.
2. **Destructured binding** (`catch ({ message, stack })`) — skip. Rewriting the
   destructuring to preserve a reference to the raw error risks colliding with
   user code; not worth the complexity for an edge case. Documented limitation.
3. **`// vantatrace-ignore`** — skip. Detected by scanning `state.file.ast.comments`
   for any comment whose source range falls between the enclosing `TryStatement`'s
   start and the first statement of the catch body (or the body's end, if empty).
   This is a range check against raw comment positions, not a reliance on Babel's
   `leadingComments`/`trailingComments`/`innerComments` attachment (which is known
   to be inconsistent across parser/formatter combinations). Covers: comment above
   `try`, comment above `catch`, inline comment after `catch (err) {`, or first line
   inside the block.
4. **Already manually captured** — skip. Traverse the catch body looking for a
   `CallExpression` matching either `<obj>.captureException(...)` or a bare
   `captureExceptionGlobal(...)` call, but do **not** descend into nested
   `Function` or nested `CatchClause` nodes (`path.skip()` on those node types).
   This scopes the check to the catch block's own synchronous flow — a manual
   capture inside an unrelated nested `try/catch` no longer wrongly suppresses
   injection in the outer block (bug in the current draft).
5. **Otherwise, inject** `<import-name>(<param-name>)` as the first statement in
   the catch body, where `<import-name>` resolves to `captureExceptionGlobal` from
   `@vantatrace/sdk/runtime`:
   - If `program.sourceType === 'module'` (file has ESM `import`/`export` syntax):
     inject via `@babel/helper-module-imports`' `addNamed`, which auto-dedupes
     (one import per file no matter how many catch blocks) and auto-generates a
     non-colliding local name.
     - **New dependency:** `@babel/helper-module-imports` (already a transitive
       dependency of most Babel toolchains; added as an explicit `dependency` of
       `@vantatrace/sdk` since the plugin needs it directly).
   - Else (CJS `sourceType: 'script'`): inject a single hoisted
     `const { captureExceptionGlobal: _vtCapture } = require('@vantatrace/sdk/runtime');`
     at the top of `Program.body`, tracked once per file via a flag stored on the
     plugin's `state` to avoid duplicate `require`s across multiple catch blocks.
6. TypeScript-typed params (`catch (err: unknown)`) need no special handling —
   `param.name` is unaffected by a `typeAnnotation` on the `Identifier` node.

## 3. Distribution

Ships inside the existing `@vantatrace/sdk` package as a `./babel-plugin` subpath
export (already the current layout — no separate package needed).

```json
{ "plugins": ["@vantatrace/sdk/babel-plugin"] }
```

Consumers with an existing Babel pipeline (Node backends, Express services) add
this one line. Framework-specific config is documented (see below) but out of
scope to test against every framework in this pass.

## 4. Config examples

**`.babelrc` (plain Node/Express):**
```json
{
  "presets": ["@babel/preset-env"],
  "plugins": ["@vantatrace/sdk/babel-plugin"]
}
```

**`next.config.js`:**
```js
module.exports = {
  babel(config) {
    config.plugins = config.plugins || [];
    config.plugins.push('@vantatrace/sdk/babel-plugin');
    return config;
  }
};
```
Note: Next.js defaults to the SWC compiler, which ignores `babel()` config unless a
`.babelrc`/`babel.config.js` is present in the project root (Next auto-detects it and
falls back to Babel). No `experimental.forceSwcTransforms` flag needed — just the
presence of a Babel config file is sufficient for Next to switch that project to the
Babel pipeline.

## 5. SWC — outline (documentation only, not implemented this pass)

- Same rule set as section 2, implemented as a Rust `#[plugin_transform]` crate
  using `swc_plugin` + `swc_ecma_visit`'s `VisitMut`, overriding
  `visit_mut_catch_clause`.
- Comment scanning: SWC doesn't attach comments to AST nodes either — use the
  `Comments` trait's byte-span lookup against the `CatchClause`/`TryStmt` spans,
  same range-based approach as section 2.3.
- Import injection: SWC visitors operate per-module; track "already injected"
  via a `bool` field on the visitor struct, inject an `ImportDecl` for
  `captureExceptionGlobal` from `@vantatrace/sdk/runtime` at `visit_mut_module`
  exit if any catch clause was instrumented.
- Compiled to `.wasm`, loaded via `next.config.js`'s
  `experimental.swcPlugins: [["@vantatrace/sdk-swc-plugin", {}]]`.
- Ships as a **separate** package (`@vantatrace/sdk-swc-plugin`) since it's a
  compiled Rust/wasm artifact with its own release/versioning cadence, not
  something `tsc` can build alongside the main SDK.

## Out of scope for this pass

- Full SWC implementation (outline only, per requirements).
- Automated test suite for the Babel plugin (recommended follow-up:
  `babel-plugin-tester` with fixture-based snapshot tests).
- Rewriting destructured catch params to recover the raw error.
