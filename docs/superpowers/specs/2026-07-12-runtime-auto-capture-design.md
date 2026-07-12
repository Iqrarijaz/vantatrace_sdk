# Runtime Auto-Capture of try/catch-Handled Exceptions — Design

## Problem

Errors handled inside a local `try/catch` never reach `errorHandler()` (the Express
error middleware) and are invisible unless the developer remembers to call
`captureException()` in every catch block:

```js
app.get('/api/v1/check', (req, res) => {
  try {
    a; // ReferenceError
  } catch (error) {
    res.status(500).json({ error: 'Order failed' }); // error silently lost
  }
});
```

Goal: `requestHandler()` + `errorHandler()` once, and the SDK captures these
automatically — Sentry/Bugsnag-grade DX.

## Root cause: why there is no simple hook

`try/catch` is resolved entirely inside the V8 VM. When a throw unwinds to a
handler, no JavaScript-observable event fires:

- `process.on('uncaughtException')` / `setUncaughtExceptionCaptureCallback` —
  only errors that escape **every** handler.
- `process.on('unhandledRejection')` — only rejections nothing ever handles.
- `async_hooks` / `AsyncLocalStorage` — tracks async context, carries no
  exception information for handled throws.
- `Error.prepareStackTrace` — fires only if someone reads `error.stack`; a
  swallowed error's stack is never read.
- Patching `globalThis.Error` (Proxy on construct) — never sees
  engine-generated errors (`ReferenceError`, `TypeError` from `a;` or
  `null.x`): V8 raises those through realm intrinsics without calling the
  patched binding.
- `domain` — deprecated, and also only observes escaping errors.

So **at the language level the feature is impossible**. It is *not* impossible
at the runtime level:

## The two mechanisms that actually work

### 1. V8 inspector protocol (runtime — what this design implements)

`Debugger.setPauseOnExceptions('all')` makes V8 deliver a `Debugger.paused`
event at **every throw site — including engine-generated errors — before the
catch block runs**, with a caught/uncaught prediction flag. An **in-process**
`node:inspector` session receives that event synchronously on the same thread,
which yields three crucial properties (all verified by test):

- the AsyncLocalStorage **request context at the throw site is still active**
  inside our handler;
- `Runtime.callFunctionOn(objectId, fn)` executes `fn` **on the real exception
  object**, letting us hand the actual `Error` instance (identity-preserving —
  the dedup `WeakSet` keeps working) back to the SDK;
- `Debugger.resume()` posted from the handler unpauses immediately — the app
  never observably stops.

This is the same mechanism Sentry's `LocalVariables` integration uses to read
stack-frame variables at throw time.

**Cost (measured, Node 22):** ~7.7µs per caught throw baseline → ~335µs with
pause-on-all-exceptions enabled; near-zero when nothing throws. Fine for code
where exceptions are exceptional; expensive for throw-as-control-flow hot
paths. Hence **opt-in**.

**Implementation notes discovered along the way:**

- Node reports empty `url` on pause call frames; script URLs must be resolved
  via `Debugger.scriptParsed` events (replayed on `Debugger.enable`), mapping
  `location.scriptId → url` (`file://…` form).
- Node internals throw/catch as control flow (e.g. one `fs.rmSync` triggers 3
  internal throws) — throw-site filtering (skip `node:` frames, skip
  `node_modules` by default) and a per-minute rate limit are mandatory, not
  nice-to-haves.
- `silent: true` on `Runtime.callFunctionOn` prevents the bridge itself from
  re-triggering pauses; a reentrancy flag guards the pause handler.

### 2. Build-time AST injection (already shipped)

The `@vantatrace/sdk/babel-plugin` rewrites every `catch (e)` to call
`captureExceptionGlobal(e)` first. Zero runtime overhead, but requires a Babel
pipeline. Kept as the recommended option for teams that already build with
Babel/Next.js.

## Reporting policy: captured ≠ worth reporting

A caught exception is often *successfully handled* — reporting all of them is
noise. The watcher therefore feeds a policy layer:

- **`report: 'request-failure'` (default):** caught exceptions are buffered on
  the request's ALS store (cap 20). When the response finishes:
  - status < 500 → buffer discarded (the code recovered — not an error);
  - status ≥ 500 and nothing was reported for this request → the **first**
    buffered exception is sent as the root cause (`severity: 'critical'`,
    `metadata.captureStrategy: 'caughtException'`), with later ones summarized
    in `metadata.additionalCaughtErrors`.
- **`report: 'always'`:** every caught exception is sent immediately as
  `severity: 'warning'`. For jobs/workers outside HTTP where there is no
  response to correlate with.

Duplicate suppression: `captureException()` marks the active request store
(`_vantaErrorCaptured`), and the existing `WeakSet` dedup covers the same error
object reaching multiple layers (watcher → errorHandler → uncaughtException).

## Safety-net layer: 5xx heuristic (default ON, no inspector needed)

`requestHandler()` now also listens for the response `finish` event. If a
request ends ≥ 500 with no error reported and no buffered caught exception, it
sends a synthetic `HttpServerError` (`metadata.captureStrategy: 'http5xx'`)
carrying method/route/status and full request context. This means even with the
inspector watcher off, a swallowed error that fails a request is at least
*visible* — just without the original stack. Disable via
`autoCapture: { http5xx: false }`.

## Resulting capture ladder

| Layer | Mechanism | Overhead | Catches swallowed try/catch errors? |
|---|---|---|---|
| `errorHandler()` + global handlers | Express middleware, `process` events | ~0 | No |
| `http5xx` heuristic (default on) | `res` finish listener | ~0 | Failure visible, original stack lost |
| `caughtExceptions` (opt-in) | V8 inspector pause-on-exceptions | ~0.3–0.5ms per throw | **Yes — real error, real stack, request context** |
| Babel plugin (opt-in) | build-time AST injection | 0 runtime | Yes (requires build step) |

## How commercial SDKs handle the same limitation

- **Sentry:** does *not* auto-capture handled exceptions — docs require manual
  `captureException`. Uses the identical inspector mechanism (LocalVariables
  integration, `captureAllExceptions: true`) only to enrich stacks with
  variables, with the same documented per-throw overhead caveat.
- **Datadog (dd-trace) / New Relic:** don't hook try/catch either; they wrap
  ~100 known libraries (pg, mysql, redis, http…) so errors are observed at the
  library boundary *before* user code catches them, and flag errors on
  spans/transactions when requests fail — the same signal as our `http5xx`
  layer.
- **Bugsnag:** unhandled-only + manual `notify`.

VantaTrace's inspector watcher goes one step further than all of these by
turning throw-site observation into actual error events gated on request
outcome.

## Out of scope / future work

- Worker-thread isolation of the pause handler (Sentry's async LocalVariables
  variant) — would trade context fidelity for lower main-thread coupling.
- Library-boundary instrumentation (pg/redis/http wrappers) à la dd-trace.
- Per-route sampling of the watcher.
