# Zero-Code Catch-Block Auto-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-inject `captureExceptionGlobal(err)` into `catch` blocks at build time via a Babel plugin, resolving to a runtime singleton set automatically by `new VantaTrace(options)` — no per-file setup required.

**Architecture:** A new module-level singleton registry (`src/registry.ts`) that `VantaTrace`'s constructor registers itself into, exposed to consumer code via a dependency-light `src/runtime.ts` entry point. A rewritten `babel-plugin.js` walks `CatchClause` nodes, applies skip rules (no binding, destructured binding, `// vantatrace-ignore`, already manually captured — scoped correctly to exclude nested catch/function bodies), and injects a call to the runtime singleton, auto-importing it via `@babel/helper-module-imports` for ESM files or a hand-rolled deduped `require()` for CommonJS files.

**Tech Stack:** TypeScript (existing `tsc` build, `strict: true`, `module: commonjs`), Node's built-in `node:test` + `node:assert/strict` test runner (zero new test-framework dependency), `tsx` (dev-only, runs `.ts` tests without a separate compile step), `@babel/core` (dev + peer dependency), `@babel/helper-module-imports` (runtime dependency of the plugin).

## Global Constraints

- Node >= 18 (required for stable `node:test`).
- TypeScript `strict: true` — all new `.ts` files must satisfy strict null checks (existing `tsconfig.json`, unchanged).
- Module output stays CommonJS (`tsconfig.json` `module: commonjs`) — do not change this.
- No linter is configured in this repo — do not add one as part of this work.
- Do not change the documented `new VantaTrace(options)` Quick Start API in `README.md` section 1.
- The ignore directive string is exactly `vantatrace-ignore` (matches existing README wording) — do not rename it.
- **`npm test` runs an explicit, space-separated file list — not a glob, not bare auto-discovery.** Verified during Task 1: `npm` on this Windows setup runs scripts via `cmd.exe`, which does not expand globs, and Node's built-in test runner does not match `.test.ts` files during its own auto-discovery (only `.js`/`.mjs`/`.cjs`). Every task that adds a new test file MUST append that file's path to the `"test"` script in `package.json` in the same commit, e.g. `"tsx --test src/registry.test.ts src/runtime.test.ts"`. Task 2 adds `src/runtime.test.ts`, Task 3 adds `src/index.test.ts`, Task 4 adds `babel-plugin.test.js` — each of those tasks' steps below must include this `package.json` edit even where not spelled out verbatim.

---

### Task 1: Test runner setup + singleton registry module

**Files:**
- Modify: `package.json`
- Create: `src/registry.ts`
- Test: `src/registry.test.ts`

**Interfaces:**
- Produces: `registerGlobalInstance(instance: VantaTrace, debug: boolean): void`, `getGlobalInstance(): VantaTrace | null`, `captureExceptionGlobal(error: any, context?: VantaTraceContext): void`, `_resetForTests(): void` — all exported from `src/registry.ts`. `VantaTrace` and `VantaTraceContext` are imported as types only (`import type`) from `./index` and `./types` respectively, to avoid a runtime circular dependency with `index.ts`.

- [ ] **Step 1: Install the test runner dependency**

Run: `npm install --save-dev tsx`
Expected: exits 0; `tsx` appears under `devDependencies` in `package.json`.

- [ ] **Step 2: Add the `test` script**

In `package.json`, inside `"scripts"`, add a `test` entry (keep `build` and `prepublishOnly` as-is):

```json
  "scripts": {
    "build": "tsc",
    "test": "tsx --test",
    "prepublishOnly": "npm run build"
  },
```

`tsx --test` with no file arguments mirrors Node's built-in test-file auto-discovery (recursively finds `*.test.ts`/`*.test.js`, skips `node_modules`) — avoids relying on shell glob expansion, which is inconsistent between PowerShell/cmd.exe and POSIX shells.

- [ ] **Step 3: Write the failing test**

Create `src/registry.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerGlobalInstance,
  getGlobalInstance,
  captureExceptionGlobal,
  _resetForTests
} from './registry';

beforeEach(() => {
  _resetForTests();
});

test('registerGlobalInstance stores the first instance', () => {
  const fakeInstance = { captureException: () => {} } as any;
  registerGlobalInstance(fakeInstance, false);
  assert.equal(getGlobalInstance(), fakeInstance);
});

test('registerGlobalInstance keeps the first instance on a second registration', () => {
  const first = { captureException: () => {} } as any;
  const second = { captureException: () => {} } as any;
  registerGlobalInstance(first, false);
  registerGlobalInstance(second, false);
  assert.equal(getGlobalInstance(), first);
});

test('captureExceptionGlobal forwards error and context to the registered instance', () => {
  let capturedError: any = null;
  let capturedContext: any = null;
  const fakeInstance = {
    captureException: (error: any, context: any) => {
      capturedError = error;
      capturedContext = context;
    }
  } as any;
  registerGlobalInstance(fakeInstance, false);

  const err = new Error('boom');
  captureExceptionGlobal(err, { userId: 'u1' });

  assert.equal(capturedError, err);
  assert.deepEqual(capturedContext, { userId: 'u1' });
});

test('captureExceptionGlobal no-ops when no instance is registered', () => {
  assert.doesNotThrow(() => captureExceptionGlobal(new Error('boom')));
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/registry.ts` does not exist yet (module not found).

- [ ] **Step 5: Implement the registry**

Create `src/registry.ts`:

```ts
import type { VantaTrace } from './index';
import type { VantaTraceContext } from './types';

let globalInstance: VantaTrace | null = null;
let warnedMissingInstance = false;

/**
 * Registers the global singleton used by auto-instrumented catch blocks.
 * First instance wins; a later call logs a warning instead of replacing it.
 */
export function registerGlobalInstance(instance: VantaTrace, debug: boolean): void {
  if (globalInstance) {
    console.warn(
      '[VantaTrace] WARNING: multiple instances constructed; the first instance remains ' +
        'the global singleton used by auto-instrumented catch blocks.'
    );
    return;
  }
  globalInstance = instance;
  if (debug) {
    console.log('[VantaTrace] Registered global singleton instance for auto-instrumented catch blocks.');
  }
}

export function getGlobalInstance(): VantaTrace | null {
  return globalInstance;
}

/** Entry point injected into user code by the Babel/SWC plugins. */
export function captureExceptionGlobal(error: any, context?: VantaTraceContext): void {
  if (!globalInstance) {
    if (!warnedMissingInstance) {
      warnedMissingInstance = true;
      console.warn(
        '[VantaTrace] WARNING: captured an exception before the SDK was initialized. ' +
          'Call `new VantaTrace(options)` in your application entrypoint.'
      );
    }
    return;
  }
  globalInstance.captureException(error, context);
}

/** Test-only: resets module-level singleton state between test runs. */
export function _resetForTests(): void {
  globalInstance = null;
  warnedMissingInstance = false;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 4 passing tests in `src/registry.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add package.json src/registry.ts src/registry.test.ts
git commit -m "feat: add global singleton registry for auto-instrumented catch blocks"
```

---

### Task 2: Runtime entry point

**Files:**
- Create: `src/runtime.ts`
- Test: `src/runtime.test.ts`

**Interfaces:**
- Consumes: `captureExceptionGlobal`, `registerGlobalInstance`, `getGlobalInstance`, `_resetForTests` from `./registry` (Task 1).
- Produces: `src/runtime.ts` re-exports `captureExceptionGlobal` — this is the module the Babel plugin (Task 4) imports as `@vantatrace/sdk/runtime`. It must not import `./index` (keeps consumers of `/runtime` from pulling in Express middleware / AsyncLocalStorage / logger patching).

- [ ] **Step 1: Write the failing test**

Create `src/runtime.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureExceptionGlobal } from './runtime';
import { registerGlobalInstance, _resetForTests } from './registry';

test('runtime module re-exports a working captureExceptionGlobal', () => {
  _resetForTests();
  let called = false;
  const fakeInstance = {
    captureException: () => {
      called = true;
    }
  } as any;
  registerGlobalInstance(fakeInstance, false);

  captureExceptionGlobal(new Error('boom'));

  assert.equal(called, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/runtime.ts` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/runtime.ts`:

```ts
export { captureExceptionGlobal } from './registry';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all tests across `src/registry.test.ts` and `src/runtime.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts src/runtime.test.ts
git commit -m "feat: add runtime entry point for injected catch-block captures"
```

---

### Task 3: Wire `VantaTrace` constructor to the registry

**Files:**
- Modify: `src/index.ts:1-8` (imports), `src/index.ts:41-58` (constructor)
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: `registerGlobalInstance` from `./registry` (Task 1).
- Produces: every `new VantaTrace(options)` call registers itself as the global singleton — this is what makes Task 4's injected calls resolve to a real instance without any manual wiring.

- [ ] **Step 1: Write the failing test**

Create `src/index.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VantaTrace } from './index';
import { getGlobalInstance, captureExceptionGlobal, _resetForTests } from './registry';

test('constructing VantaTrace registers it as the global singleton', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  assert.equal(getGlobalInstance(), instance);
});

test('captureExceptionGlobal reaches captureException on the constructed instance', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });

  let seenError: any = null;
  const originalCapture = instance.captureException.bind(instance);
  instance.captureException = (error: any, context?: any) => {
    seenError = error;
    return originalCapture(error, context);
  };

  const err = new Error('integration boom');
  captureExceptionGlobal(err);

  assert.equal(seenError, err);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `getGlobalInstance()` returns `null` because the constructor doesn't register itself yet.

- [ ] **Step 3: Modify `src/index.ts`**

Add the import. In the existing import block (currently `src/index.ts:1-7`):

```ts
import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';
import { VantaTraceOptions, VantaTraceContext, ErrorPayload } from './types';
import { normalizeError } from './normalizer';
import { getSystemContext, startTelemetrySampling } from './context';
import { sendPayload } from './transport';
import { createWinstonTransport } from './winston';
import { registerGlobalInstance } from './registry';
```

Register at the end of the constructor. Currently (`src/index.ts:56-58`):

```ts
    // Start background system telemetry sampler (runs every 10 seconds, unrefed)
    startTelemetrySampling(10000);
  }
```

Change to:

```ts
    // Start background system telemetry sampler (runs every 10 seconds, unrefed)
    startTelemetrySampling(10000);

    registerGlobalInstance(this, this.debug);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all tests across `src/registry.test.ts`, `src/runtime.test.ts`, `src/index.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: auto-register VantaTrace instances as the global singleton on construction"
```

---

### Task 4: Rewrite the Babel plugin

**Files:**
- Modify: `package.json`
- Modify: `babel-plugin.js` (full rewrite)
- Test: `babel-plugin.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks at compile time (the plugin only emits *references* to `@vantatrace/sdk/runtime`'s `captureExceptionGlobal` export — it never imports Tasks 1–3's TypeScript source directly).
- Produces: a Babel plugin default-exported from `babel-plugin.js`, consumed by Task 5's `package.json` `"./babel-plugin"` export.

- [ ] **Step 1: Install plugin dependencies**

Run: `npm install --save-dev @babel/core`
Run: `npm install --save @babel/helper-module-imports`

Expected: both exit 0. `@babel/core` appears under `devDependencies`; `@babel/helper-module-imports` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing tests**

Create `babel-plugin.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — the current `babel-plugin.js` references a bare `vantaTrace` identifier, so none of the new assertions about `@vantatrace/sdk/runtime` imports match.

- [ ] **Step 4: Rewrite the plugin**

Replace the full contents of `babel-plugin.js`:

```js
const { addNamed } = require('@babel/helper-module-imports');

const RUNTIME_IMPORT_SOURCE = '@vantatrace/sdk/runtime';
const IMPORTED_FUNCTION_NAME = 'captureExceptionGlobal';
const IGNORE_DIRECTIVE = 'vantatrace-ignore';

function isIgnored(path, state) {
  const tryStatementNode = path.parentPath.node;
  const bodyStatements = path.node.body.body;
  const searchEnd = bodyStatements.length > 0 ? bodyStatements[0].start : path.node.body.end;
  const comments = (state.file && state.file.ast && state.file.ast.comments) || [];

  // Comments inline after `catch (err) {` or as the first line inside the block.
  const hasIgnoreInRange = comments.some(
    (comment) =>
      comment.value.includes(IGNORE_DIRECTIVE) &&
      comment.start >= tryStatementNode.start &&
      comment.end <= searchEnd
  );
  if (hasIgnoreInRange) return true;

  // Comments directly above `try` fall outside that range (they precede
  // tryStatementNode.start) — Babel attaches these as the TryStatement's own
  // leadingComments, so check that separately.
  const leadingComments = tryStatementNode.leadingComments || [];
  return leadingComments.some((comment) => comment.value.includes(IGNORE_DIRECTIVE));
}

// Detects a pre-existing `x.captureException(...)` or bare `captureExceptionGlobal(...)`
// call within this catch block's own synchronous flow. Does NOT descend into nested
// functions or nested catch clauses, so a manual capture inside an unrelated nested
// try/catch does not suppress injection in the outer block.
function alreadyManuallyCaptures(path, t) {
  let found = false;
  path.get('body').traverse({
    CallExpression(callPath) {
      const callee = callPath.node.callee;
      const isMemberCapture =
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property, { name: 'captureException' });
      const isBareGlobalCapture = t.isIdentifier(callee, { name: IMPORTED_FUNCTION_NAME });
      if (isMemberCapture || isBareGlobalCapture) {
        found = true;
        callPath.stop();
      }
    },
    Function(fnPath) {
      fnPath.skip();
    },
    CatchClause(nestedPath) {
      nestedPath.skip();
    }
  });
  return found;
}

function ensureEsmImport(path) {
  const identifier = addNamed(path, IMPORTED_FUNCTION_NAME, RUNTIME_IMPORT_SOURCE);
  return identifier.name;
}

function ensureCjsImport(programPath, state, t) {
  if (state.vantaTraceCjsLocalName) return state.vantaTraceCjsLocalName;

  const localId = programPath.scope.generateUidIdentifier('vantaTraceCapture');
  const requireDeclaration = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.objectPattern([
        t.objectProperty(t.identifier(IMPORTED_FUNCTION_NAME), t.identifier(localId.name), false, false)
      ]),
      t.callExpression(t.identifier('require'), [t.stringLiteral(RUNTIME_IMPORT_SOURCE)])
    )
  ]);

  programPath.unshiftContainer('body', requireDeclaration);
  state.vantaTraceCjsLocalName = localId.name;
  return localId.name;
}

module.exports = function ({ types: t }) {
  return {
    name: 'vantatrace-catch-injector',
    visitor: {
      CatchClause(path, state) {
        const param = path.node.param;

        // catch {} with no binding (ES2019 optional catch) - no error object to capture.
        if (!param) return;

        // catch ({ message }) / catch ([a, b]) - destructured binding. Skipped:
        // rewriting the destructure to recover the raw error risks colliding with
        // user code.
        if (!t.isIdentifier(param)) return;

        if (isIgnored(path, state)) return;
        if (alreadyManuallyCaptures(path, t)) return;

        const programPath = path.scope.getProgramParent().path;
        const isEsm = programPath.node.sourceType === 'module';
        const localName = isEsm
          ? ensureEsmImport(path)
          : ensureCjsImport(programPath, state, t);

        const captureCall = t.expressionStatement(
          t.callExpression(t.identifier(localName), [t.identifier(param.name)])
        );

        path.node.body.body.unshift(captureCall);
      }
    }
  };
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests across all `*.test.ts` files and `babel-plugin.test.js` pass (17 total).

- [ ] **Step 6: Commit**

```bash
git add package.json babel-plugin.js babel-plugin.test.js
git commit -m "feat: rewrite babel plugin to auto-import the runtime singleton and fix nested-catch scoping bug"
```

---

### Task 5: Packaging and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md:96-155` (section 3 note + section 5 "Zero-Code Auto-Capture")

**Interfaces:**
- Consumes: nothing new — this task only changes package metadata and docs so Tasks 1–4's code is actually resolvable and documented for consumers.

- [ ] **Step 1: Add `files`, `exports`, and `peerDependencies` to `package.json`**

In `package.json`, add a `"files"` array (controls what `npm publish` includes — currently absent, meaning `dist/` would be excluded from the published package since it's gitignored):

```json
  "files": [
    "dist",
    "babel-plugin.js"
  ],
```

Add an `"exports"` map (keep the existing top-level `"main"`/`"types"` fields for older tooling):

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "default": "./dist/runtime.js"
    },
    "./babel-plugin": "./babel-plugin.js"
  },
```

Add `peerDependencies`/`peerDependenciesMeta` (consumers supply their own Babel version; it's optional since not everyone uses the babel plugin):

```json
  "peerDependencies": {
    "@babel/core": "^7.24.0"
  },
  "peerDependenciesMeta": {
    "@babel/core": {
      "optional": true
    }
  },
```

- [ ] **Step 2: Verify `npm pack` includes the right files**

Run: `npm run build`
Expected: exits 0; `dist/index.js`, `dist/registry.js`, `dist/runtime.js` all exist.

Run: `npm pack --dry-run`
Expected: file list includes `dist/index.js`, `dist/registry.js`, `dist/runtime.js`, `babel-plugin.js`, `package.json`, `README.md`. Does NOT include `src/`, `*.test.ts`, `*.test.js`, `docs/`.

- [ ] **Step 3: Update README section 3 (deprecation note) — no content change needed, verify only**

Read `README.md:96-98` and confirm the existing `expressMiddleware()` deprecation note still applies unchanged (it does — unrelated to this feature). No edit required here; this step is a verification checkpoint, not a code change.

- [ ] **Step 4: Rewrite README section 5**

Replace `README.md:122-154` (the existing "5. Zero-Code Auto-Capture (Babel Plugin)" section) with:

```markdown
### 5. Zero-Code Auto-Capture (Babel Plugin)

VantaTrace includes a Babel plugin that automatically injects an error capture
call into every `try/catch` block in your codebase at build time — no manual
`vantaTrace.captureException()` calls required, and no per-file imports to
remember. It resolves to whichever `VantaTrace` instance you constructed in
your entrypoint (see step 1) automatically.

**Setup in `.babelrc` or `babel.config.js`:**

```json
{
  "plugins": ["@vantatrace/sdk/babel-plugin"]
}
```

**Next.js (`next.config.js`):**

```js
module.exports = {
  babel(config) {
    config.plugins = config.plugins || [];
    config.plugins.push('@vantatrace/sdk/babel-plugin');
    return config;
  }
};
```

Next.js defaults to its SWC compiler, but auto-detects a `.babelrc`/`babel.config.js`
in your project root and switches that project to the Babel pipeline — no extra
flags needed.

**How it works:**

It transforms this:
```javascript
try {
  doSomething();
} catch (error) {
  res.status(500).json({ error: 'Failed' });
}
```

Into this:
```javascript
import { captureExceptionGlobal } from '@vantatrace/sdk/runtime';
// ...
try {
  doSomething();
} catch (error) {
  captureExceptionGlobal(error);
  res.status(500).json({ error: 'Failed' });
}
```

(In CommonJS files, it injects an equivalent `require('@vantatrace/sdk/runtime')`
instead of an `import`.)

**Skip rules — the plugin will NOT inject a capture call when:**
- The catch block has no binding: `catch { ... }`.
- The catch binding is destructured: `catch ({ message }) { ... }`.
- `captureException`/`captureExceptionGlobal` is already called manually within
  that same catch block.
- A `// vantatrace-ignore` comment appears above the `try`, above the `catch`,
  or inline on the `catch (err) {` line:
  ```javascript
  try {
    doSomething();
  } catch (error) { // vantatrace-ignore
    // expected control flow — not an error worth reporting
  }
  ```
```

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "docs: document zero-code catch-block auto-capture and finalize package exports"
```

---

### Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Clean install**

Run: `rm -rf node_modules dist && npm install`
Expected: exits 0, no missing peer dependency errors (peer is optional).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0. `dist/index.js`, `dist/registry.js`, `dist/runtime.js`, `dist/registry.d.ts`, `dist/runtime.d.ts` all exist.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS — all tests across `src/registry.test.ts`, `src/runtime.test.ts`, `src/index.test.ts`, `babel-plugin.test.js` pass, 0 failures.

- [ ] **Step 4: Manual smoke test of the plugin end-to-end**

Run (from `sdk/` directory):

```bash
node -e "
const { transformSync } = require('@babel/core');
const out = transformSync(
  \"try { risky(); } catch (err) { console.log('handled', err); }\",
  { plugins: [require.resolve('./babel-plugin.js')], sourceType: 'script', babelrc: false, configFile: false }
);
console.log(out.code);
"
```

Expected output includes a hoisted `const { captureExceptionGlobal: _vantaTraceCapture } = require("@vantatrace/sdk/runtime");` and `_vantaTraceCapture(err);` as the first statement inside the catch block.

- [ ] **Step 5: Report results to the user**

Summarize: build clean, test count/pass status, confirm `npm pack --dry-run` file list from Task 5 Step 2 still looks correct after the clean install.
