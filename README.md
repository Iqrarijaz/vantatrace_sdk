# 🚀 VantaTrace Node.js SDK

[![npm version](https://img.shields.io/npm/v/@vantatrace/sdk.svg)](https://www.npmjs.com/package/@vantatrace/sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![TypeScript](https://img.shields.io/badge/TypeScript-full%20types-3178c6.svg)](#typescript-support)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-339933.svg)](#requirements)

**VantaTrace** is a lightweight, high-performance observability SDK for Node.js
microservices and Express.js APIs. It captures **exceptions, structured
telemetry, and runtime context** — including errors your code already
recovers from in a `try/catch` — and ships them to your VantaTrace project
asynchronously, so instrumentation never adds meaningful latency to a request.

This README is the complete guide: every public API, every config option, and
every automatic behavior the SDK performs on your behalf, documented in one
place.

---

## Table of Contents

- [Features](#-key-features)
- [Installation](#-installation)
- [Requirements](#requirements)
- [Quick Start](#-quick-start)
- [Configuration Reference](#configuration-reference)
- [Express Integration](#express-integration)
  - [Automatic Context Enrichment](#automatic-context-enrichment)
- [Manual Error Capturing](#manual-error-capturing)
  - [Error Context & Root Cause Chains](#error-context--root-cause-chains)
- [Automatic Capture of try/catch Errors](#automatic-capture-of-trycatch-errors)
- [Zero-Code Auto-Capture (Babel Plugin)](#zero-code-auto-capture-babel-plugin)
- [Breadcrumbs](#breadcrumbs)
- [Logger Integrations (Winston / Pino)](#logger-integrations-winston--pino)
- [Trace IDs & Log Correlation](#trace-ids--log-correlation)
- [Global Process Handlers](#global-process-handlers)
- [Security & Data Redaction](#security--data-redaction)
- [Performance, Reliability & Internals](#performance-reliability--internals)
- [TypeScript Support](#typescript-support)
- [API Reference](#api-reference)
- [Multiple Instances / Microservices](#multiple-instances--microservices)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## ✨ Key Features

- ⚡ **Zero-blocking architecture** — every send is async, batched, and never awaited on your request path
- 🧠 **Smart error grouping** — errors are fingerprinted (name + message + stack shape) so identical failures dedupe into one issue instead of flooding your dashboard
- 🔍 **Rich runtime context** — request, user, system, and environment metadata attached automatically
- 🪤 **Catches errors your code already swallows** — a failed-request safety net plus an opt-in V8-inspector watcher recover exceptions handled inside `try/catch`, not just ones that escape to Express's error handler
- ⛓️ **Root cause chains** — automatically walks and captures native `Error.cause` chains
- 🏷️ **Rich error parameters** — auto-extracts `code`, `statusCode`, and any custom properties attached to the Error instance (`extra`)
- 🍞 **Breadcrumbs** — automatic console/HTTP breadcrumb trail, plus a manual API
- 📎 **Trace ID correlation** — every captured error carries a trace ID you can stamp onto your own logs
- 🪵 **Logger integrations** — auto-patches Winston and Pino to capture logged errors, no extra wiring
- 🔒 **Secure by default** — automatic redaction of passwords, tokens, secrets, cookies, PINs, and card data in bodies, query strings, and headers alike
- 🧩 **Zero-code instrumentation** — an optional Babel plugin injects capture calls into every `try/catch` at build time, with zero runtime overhead
- 🌐 **Multi-service support** — a `serviceName` label per instance, built for microservice fleets
- 🛡️ **Self-defending transport** — backpressure ceilings, retry, gzip, connection pooling, and an automatic kill-switch if your API key is disabled
- 🚦 **Rate limiting with drop visibility** — global and per-fingerprint caps protect against event storms, with a production-visible (not just `debug`) summary of anything actually dropped
- 🔗 **Distributed tracing (W3C Trace Context)** — extracts and propagates standard `traceparent` headers, so a trace continues correctly across service boundaries instead of restarting at every hop
- 📘 **Full TypeScript support** — written in TypeScript, ships with `.d.ts` declarations

---

## 📦 Installation

```bash
npm install @vantatrace/sdk
```

### Requirements

- **Node.js 16+** (the SDK relies on `AsyncLocalStorage` and `crypto.randomUUID`)
- Express is optional — `requestHandler()`/`errorHandler()` are Express middleware, but `captureException()` and global handlers work in any Node.js process (workers, cron jobs, queue consumers)
- Winston/Pino are optional peer integrations — the SDK detects them at runtime and does nothing if they aren't installed

---

## ⚡ Quick Start

First, sign up and get your API key from [https://vantatrace.com](https://vantatrace.com).

### 1. Initialize the SDK

Construct exactly **one** `VantaTrace` instance per process, in your
application's entrypoint:

```javascript
import { VantaTrace } from '@vantatrace/sdk';

const vantaTrace = new VantaTrace({
  apiKey: 'YOUR_PROJECT_API_KEY', // starts with ep_live_ or ep_test_
  serviceName: 'checkout-service', // optional — labels events on the dashboard
  debug: false
});
```

### 2. Enable Global Error Tracking

```javascript
vantaTrace.initGlobalHandlers();
```

This wires up three safety nets in one call: uncaught exceptions, unhandled
promise rejections, and interception of errors logged via `console.error`,
Winston, or Pino. See [Global Process Handlers](#global-process-handlers).

### 3. Express Middleware Integration

VantaTrace uses a decoupled two-part middleware design for Express to ensure
complete request context tracking without leaking scopes:

1. **`requestHandler()`** — mounted at the very top of your middleware stack
   (before any routes or body parsers) to establish the `AsyncLocalStorage`
   request context.
2. **`errorHandler()`** — mounted at the very bottom of your middleware stack
   (after all routes and controllers) to capture unhandled exceptions under
   the correct request context.

```javascript
import express from 'express';
import { VantaTrace } from '@vantatrace/sdk';

const vantaTrace = new VantaTrace({ apiKey: 'YOUR_API_KEY' });
const app = express();

// 1. Mount requestHandler at the very top of the application stack
app.use(vantaTrace.requestHandler());

// Body parsers, CORS, and other middlewares
app.use(express.json());

// Routes
app.get('/checkout', (req, res) => {
  throw new Error('Payment gateway timeout');
});

// 2. Mount errorHandler at the bottom, before custom error responders
app.use(vantaTrace.errorHandler());

// Custom fallback error responder
app.use((err, req, res, next) => {
  res.status(500).send('Internal Server Error');
});
```

> [!NOTE]
> `vantaTrace.expressMiddleware()` is deprecated but preserved as an alias for
> `errorHandler()` for backward compatibility.

That's the whole setup. Everything below documents what each piece does and
how to go further — manual capture, catching swallowed errors, breadcrumbs,
logger integrations, and the zero-code Babel plugin.

---

## Configuration Reference

Options passed to `new VantaTrace({ ... })`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | **Required.** Your VantaTrace project API key. If omitted, the SDK runs in dry-run mode (logs what it *would* send when `debug: true`, sends nothing). |
| `serviceName` | `string` | — | Logical service name attached to every event — how you tell microservices apart on the dashboard. |
| `apiUrl` | `string` | `https://api.vantatrace.com/api/events` | Override the ingestion endpoint (self-hosted/enterprise deployments). |
| `debug` | `boolean` | `false` | Logs SDK internals to the console — capture attempts, batch sends, retries, disabled-key state. |
| `autoCapture.http5xx` | `boolean` | `true` | Emit a synthetic error when a request finishes 5xx with no exception reported (see [4a](#automatic-capture-of-trycatch-errors)). |
| `autoCapture.httpClientErrors` | `boolean \| { exclude?: number[] }` | `true`, excluding `[401, 404]` | Emit a synthetic warning-severity error for eligible 4xx responses with no exception reported (see [4a](#automatic-capture-of-trycatch-errors)). |
| `autoCapture.caughtExceptions` | `boolean \| CaughtExceptionCaptureOptions` | `false` | Opt-in V8-inspector watcher that recovers the *real* error object from inside `try/catch` blocks (see [4b](#automatic-capture-of-trycatch-errors)). |
| `autoCapture.caughtExceptions.report` | `'request-failure' \| 'always'` | `'request-failure'` | Whether caught exceptions are only reported when the request ultimately fails, or always. |
| `autoCapture.caughtExceptions.includeNodeModules` | `boolean` | `false` | Also capture exceptions thrown from inside `node_modules`. |
| `autoCapture.caughtExceptions.maxPerMinute` | `number` | `120` | Ceiling on recorded caught exceptions per minute, to protect throw-heavy hot paths. |
| `autoCapture.caughtExceptions.allowInProduction` | `boolean` | `false` | Required to actually enable the V8 inspector watcher when `NODE_ENV=production` — otherwise it's auto-disabled with a warning, even if `caughtExceptions` was requested. Has no effect outside production. |
| `maskingKeys` | `string[]` | `[]` (merged with built-in defaults) | Additional field names (exact match, case-insensitive) to redact from Winston log metadata (see [Masking log metadata](#masking-log-metadata)). |
| `rateLimit.maxPerMinute` | `number \| false` | `1000` | Global cap on captured events per minute, across all fingerprints. `false` disables it. |
| `rateLimit.maxPerFingerprintPerMinute` | `number \| false` | `150` | Cap on captured events per minute for a single error fingerprint. `false` disables it. |
| `rateLimit.sampleRate` | `number` | `1` | Fraction (0..1) of events allowed through after both caps pass. |

---

## Express Integration

### Automatic Context Enrichment

`requestHandler()` populates the active request's context automatically —
none of this requires a manual `captureException()` call; it's merged into
every error captured while the request is in flight.

| Field | Source |
| --- | --- |
| `userId` | `req.user.id` → `req.user._id` → `req.user.userId` → `req.userId`, in that order — whichever auth middleware you use, as long as it runs **before** `requestHandler()`. |
| `user` | `{ id, email, role, tenantId, orgId }`, pulled off `req.user` when it's an object. |
| `msisdn` | `X-MSISDN` header, or `req.user.phone` / `mobilephone` / `msisdn` / `phoneNumber` / `mobileNumber`. Normalized to digits + optional leading `+`, and validated as phone-shaped (7–15 digits) — anything that doesn't look like a real number is dropped rather than forwarded. |
| `appVersion` | `X-APP-VERSION` header, trimmed and capped at 64 characters. Powers release tracking on the dashboard. |
| `route` / `method` | `req.route.path` / `req.path` / `req.url`, and `req.method`. |
| `ip` / `geo` | `req.ip`, `X-Forwarded-For`, or the socket's remote address; country/region/city from common CDN headers (`CF-IPCountry`, `X-GeoIP-*`, etc.) if your edge/proxy sets them. |
| `headers` | The full request header set, with sensitive headers redacted (see [Security](#security--data-redaction)). |
| `body` / `query` | The parsed request body and query string, with sensitive keys redacted. |
| `sessionId` | `req.sessionID`, `req.session.id`, or `X-Session-Id`. |
| `correlationId` | `X-Correlation-Id`, `X-Request-Id`, or `X-Trace-Id`. |
| `featureFlags` | `req.featureFlags` / `req.flags` / `req.experiments`, if your app sets one of these. |
| `duration` | Milliseconds elapsed between `requestHandler()` running and the error being captured. |

> [!IMPORTANT]
> **`userId` is auto-extracted, not a header.** Unlike `appVersion`, there is
> no `X-USER-ID` header fallback — the SDK only ever reads `req.user.*` /
> `req.userId`. This only works if **your own auth middleware runs before
> `vantaTrace.requestHandler()`** in the middleware chain and actually sets
> `req.user` (or `req.userId`). If your auth middleware runs after
> `requestHandler()`, or you don't use `req.user` at all, every captured
> event will have **no `userId`**, and per-user filtering/dashboards on the
> backend will simply be empty — VantaTrace has no other way to know who hit
> the error. If auto-extraction doesn't fit your setup, pass it explicitly
> per call instead: `captureException(error, { userId })` — this always
> takes precedence over whatever was auto-extracted.

> [!IMPORTANT]
> **`appVersion` is auto-extracted from the inbound `X-APP-VERSION` request
> header — VantaTrace does not compute or guess it.** It's populated purely
> from whatever your client (browser/mobile app) sends on the request that
> triggered the error. **If your client never sends an `X-APP-VERSION`
> header, no release will be attached to that event**, and it won't appear
> under any release in the dashboard's release tracking view. Make sure the
> client you're instrumenting sends its own build/app version in that header
> on every request for release tracking to work. Like `userId`, you can also
> set it explicitly per call via `captureException(error, { appVersion:
> '2.3.1' })` if you'd rather not rely on the header.

**Headers carrying secrets are always redacted, never captured.** Any header
whose name looks like it carries a secret — `Authorization`, `Cookie`,
`X-Api-Key`, and (importantly) **`X-MPIN`** — is replaced with `[REDACTED]`
in `context.headers` before the event ever leaves `requestHandler()`. This
uses the same substring check as body/query redaction, so an MPIN sent as a
header is never stored, logged, or forwarded in any form — independent of
the backend's own defense-in-depth scrubbing.

---

## Manual Error Capturing

```javascript
try {
  await processOrder();
} catch (error) {
  vantaTrace.captureException(error, {
    userId: 'user_8872',
    route: '/api/v1/orders',
    method: 'POST',
    severity: 'warning',
    metadata: {
      orderId: 'ord_128d9a',
      amount: 149.5
    }
  });
}
```

Severity shortcuts are also available:

```javascript
vantaTrace.captureCritical(error);
vantaTrace.captureWarning(error);
vantaTrace.captureInfo(error);
```

Any field on `VantaTraceContext` can be passed to `captureException()` (or
the severity helpers) to override or supplement whatever was
auto-extracted from the active request:

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | `string` | Overrides the auto-extracted user ID. |
| `user` | `{ id, email, role, tenantId, orgId }` | Structured user info. |
| `route` / `method` | `string` | Overrides the auto-extracted route/method — useful outside Express (queue consumers, cron jobs). |
| `ip`, `geo`, `headers`, `body`, `query` | — | Same shape as the auto-extracted fields. |
| `msisdn` / `appVersion` | `string` | Explicit overrides for phone number / release version. |
| `sessionId` / `correlationId` | `string` | Explicit correlation identifiers. |
| `duration` | `number` | Milliseconds, if you want to report your own timing. |
| `featureFlags` | `Record<string, any>` | Arbitrary flag state active during the error. |
| `metadata` | `Record<string, any>` | Free-form custom data — merged with any metadata already on the active request context. |
| `severity` | `'critical' \| 'warning' \| 'info'` | Defaults to `'critical'` if unset. |
| `breadcrumbs` | `Breadcrumb[]` | Rarely set manually — see [Breadcrumbs](#breadcrumbs). |

### Error Context & Root Cause Chains

VantaTrace automatically extracts and normalizes the following properties
directly from your captured `Error` objects:

- **`code`** — system or custom error codes (e.g. `ENOENT`, `ECONNREFUSED`).
- **`statusCode`** — HTTP response status codes (e.g. `404`, `500`), read from either `.statusCode` or `.status`.
- **`extra`** — any custom properties attached to the Error instance at throw-time (e.g. `error.userId = 'user_1'`).
- **`cause` (nested cause chains)** — if your errors use the native `Error.cause` option, VantaTrace recursively walks the entire chain (up to 5 levels deep, with circular-reference protection) and normalizes it.

```javascript
try {
  try {
    throw new Error('Database connection failed', { cause: new Error('Socket timeout') });
  } catch (dbErr) {
    throw new Error('Failed to checkout order', { cause: dbErr });
  }
} catch (error) {
  vantaTrace.captureException(error); // captures: Order error -> DB error -> Socket timeout
}
```

On the dashboard, the entire root-cause chain is rendered as an interactive
visual timeline directly under the main stack trace block.

---

## Automatic Capture of try/catch Errors

Errors handled inside a local `try/catch` never reach the error middleware:

```javascript
app.get('/api/v1/check', (req, res) => {
  try {
    a; // ReferenceError
  } catch (error) {
    res.status(500).json({ error: 'Order failed' }); // silently lost?
  }
});
```

VantaTrace captures these automatically — no `captureException()` call and
no per-catch-block changes required — through two layers:

### 4a. Failed-request safety net (enabled by default)

When a request finishes with a **5xx status** and no error was reported for
it, the SDK emits a synthetic `HttpServerError` event (severity `critical`)
carrying the method, route, status code, and full request context
(`metadata.captureStrategy: 'http5xx'`). The failure becomes visible on the
dashboard even though the original error object was swallowed. Disable with:

```javascript
new VantaTrace({ apiKey, autoCapture: { http5xx: false } });
```

**4xx responses are covered too**, at a lower severity. A `res.status(400)`
or `res.status(422)` sent by application code with no `throw` is exactly the
kind of "handled gracefully, invisible everywhere else" failure this feature
exists for — a plain try/catch-based tracker never sees it either. These emit
a synthetic `HttpClientError` (severity `warning`,
`metadata.captureStrategy: 'http4xx'`) so you can track validation-error
rates and anomaly spikes per route without treating every 4xx as a page-worthy
incident.

`401` and `404` are excluded by default — routine token expiry and
not-found/bot traffic aren't defects, and including them would drown out the
signal. Override the exclusion list, or disable 4xx capture entirely:

```javascript
// Track everything except 404s (e.g. you *do* want to know about 401 spikes,
// which can indicate an auth outage or a broken OAuth integration):
new VantaTrace({ apiKey, autoCapture: { httpClientErrors: { exclude: [404] } } });

// Disable 4xx capture entirely (5xx capture is unaffected):
new VantaTrace({ apiKey, autoCapture: { httpClientErrors: false } });
```

Two things make this safety net more useful without any extra config:

- **The response body is captured too.** Whatever your catch block actually
  sent back to the client (`res.json({ error: 'Order failed' })`,
  `res.send(...)`) is attached as `metadata.responseBody` — often the single
  most concrete clue about what went wrong, even with no recovered exception.
- **The message tells you what to do next.** If `autoCapture.caughtExceptions`
  isn't enabled, the synthetic error's message includes a pointer to section
  4b below (or the Babel plugin) so the fix is discoverable from the
  dashboard itself, not just this README.

### 4b. Deep capture via the V8 inspector (opt-in)

JavaScript has no language-level hook for caught exceptions — `try/catch` is
resolved entirely inside the V8 VM (this is why Sentry and Bugsnag require
manual capture calls for handled errors). The one runtime mechanism that can
observe them is the V8 inspector protocol: with pause-on-exceptions enabled,
V8 notifies an in-process `node:inspector` session at **every throw site,
before the catch block runs** — including engine-generated errors like
`ReferenceError` and `TypeError`. VantaTrace uses this to recover the *real*
error object with its full stack trace and request context:

```javascript
const vantaTrace = new VantaTrace({
  apiKey: 'YOUR_API_KEY',
  autoCapture: {
    caughtExceptions: true
  }
});
```

With this enabled, the `/api/v1/check` example above reports the actual
`ReferenceError: a is not defined` — with the stack pointing at your route
code — automatically.

**Reporting policy.** Caught exceptions are often successfully handled, so by
default the SDK buffers them per request and reports only when the request
actually fails:

```javascript
autoCapture: {
  caughtExceptions: {
    report: 'request-failure', // default: report only if the request ends >= 500
    // report: 'always',       // report every caught exception immediately (severity: warning)
    includeNodeModules: false, // ignore throws originating inside node_modules (default)
    maxPerMinute: 120          // recording ceiling to protect throw-heavy hot paths
  }
}
```

- `'request-failure'` (default): errors your code recovered from (response
  < 500) are never reported — zero noise. If the request ends 5xx, the first
  caught exception is reported as the root cause with any later ones
  summarized in `metadata.additionalCaughtErrors`.
- `'always'`: also captures caught exceptions outside HTTP requests (queue
  consumers, cron jobs).

Duplicates are automatically suppressed: an error that is caught, rethrown,
and then reaches `errorHandler()` (or a manual `captureException`) is
reported exactly once.

> [!WARNING]
> When `NODE_ENV=production`, `autoCapture.caughtExceptions` is **auto-disabled**
> — a real operational trade-off (the V8 inspector watcher adds roughly
> **0.3–0.5ms per thrown exception** while enabled) isn't something to opt
> into implicitly. A console warning explains why nothing was started and
> points at the [Babel plugin](#zero-code-auto-capture-babel-plugin) as the
> production-safe, zero-runtime-overhead alternative. Set
> `autoCapture.caughtExceptions.allowInProduction: true` to enable it in
> production anyway (still logs a warning, since it remains a real trade-off).
> Outside production, `caughtExceptions: true` works as documented above with
> no extra flag needed.

Call `vantaTrace.shutdown()` on graceful shutdown to detach the inspector
session (optional; safe to call multiple times).

---

## Zero-Code Auto-Capture (Babel Plugin)

VantaTrace includes a Babel plugin that automatically injects an error
capture call into every `try/catch` block in your codebase at build time —
no manual `vantaTrace.captureException()` calls required, and no per-file
imports to remember. It resolves to whichever `VantaTrace` instance you
constructed in your entrypoint (see Quick Start) automatically.

**Setup in `.babelrc` or `babel.config.js`:**

```json
{
  "presets": ["@babel/preset-env"],
  "plugins": ["@vantatrace/sdk/babel-plugin"]
}
```

> [!NOTE]
> The plugin auto-imports its runtime helper as an ESM `import` or a
> CommonJS `require()` depending on Babel's detected `sourceType` for each
> file. A module transform like `@babel/preset-env` (or setting
> `sourceType: "unambiguous"`) makes sure that import is correctly compiled
> down for CommonJS codebases — without one, a plain CommonJS file with no
> `import`/`export` syntax will otherwise get an ESM `import` injected into
> it and fail at runtime with `SyntaxError: Cannot use import statement
> outside a module`.

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

Next.js defaults to its SWC compiler, but auto-detects a
`.babelrc`/`babel.config.js` in your project root and switches that project
to the Babel pipeline — no extra flags needed.

**How it works.** It transforms this:

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

(In CommonJS files, it injects an equivalent
`require('@vantatrace/sdk/runtime')` instead of an `import`.)

**Skip rules — the plugin will NOT inject a capture call when:**

- The catch block has no binding: `catch { ... }`.
- The catch binding is destructured: `catch ({ message }) { ... }`.
- `captureException`/`captureExceptionGlobal` is already called manually
  within that same catch block.
- A `// vantatrace-ignore` comment appears above the `try`, above the
  `catch`, or inline on the `catch (err) {` line:
  ```javascript
  try {
    doSomething();
  } catch (error) { // vantatrace-ignore
    // expected control flow — not an error worth reporting
  }
  ```

> [!NOTE]
> The injected `captureExceptionGlobal()` call resolves to whichever
> `VantaTrace` instance registered first in the process (see
> [Multiple Instances](#multiple-instances--microservices)) — if no instance
> has been constructed yet when a Babel-instrumented catch block runs, the
> call is a one-time-warned no-op rather than a crash.

---

## Breadcrumbs

Breadcrumbs are a lightweight timeline of events leading up to an error —
shown on the dashboard directly above the stack trace. VantaTrace records
two kinds automatically, and exposes a manual API for your own:

- **Console breadcrumbs.** Once `initGlobalHandlers()` is called, every
  `console.log` / `console.info` / `console.warn` / `console.error` call
  in your app is recorded as a breadcrumb (capped at the last 50 per
  request). An `Error` instance passed to `console.error(...)` is also
  captured as a real exception, not just a breadcrumb.
- **Outbound HTTP breadcrumbs.** Every outgoing `http`/`https` request your
  app makes (via Node's built-in modules, which most HTTP clients use
  under the hood) is recorded as a breadcrumb with its method and URL —
  useful for seeing "we called the payment gateway, then it failed." Calls
  to VantaTrace's own ingestion endpoint are excluded so they don't spam
  the trail. This is always on — no `initGlobalHandlers()` call needed.

**Manual breadcrumbs:**

```javascript
vantaTrace.addBreadcrumb({
  category: 'checkout',
  message: 'Applied discount code SUMMER25',
  level: 'info',
  type: 'business-logic',
  data: { discountCode: 'SUMMER25', amount: 12.5 }
});
```

Breadcrumbs are scoped to the active request (via `AsyncLocalStorage`) and
capped at 50 per request — the oldest is dropped once the cap is reached, so
memory use per request stays bounded regardless of how chatty a request is.

---

## Logger Integrations (Winston / Pino)

Calling `initGlobalHandlers()` also auto-patches Winston and Pino, if either
is installed in your project — no extra transport wiring required:

- **Winston** — VantaTrace registers itself as an additional transport.
  Any log entry that is (or carries) an `Error` — `logger.error(err)`,
  `logger.error('msg', { err })`, `logger.error({ event, err })` — is
  captured, with Winston's log level mapped to VantaTrace severity
  (`error` → `critical`, `warn` → `warning`, everything else → `info`).
  Winston's common single-object calling convention (`logger.error({ event,
  functionName, err })`, with no explicit `message` key) is handled
  correctly — Winston nests the whole object under `info.message` in that
  case, and VantaTrace unwraps it rather than only reading top-level fields.
  **Only a real `Error` instance is captured this way** — logging a
  destructured copy (`err: { message: err.message, stack: err.stack }`)
  is not, since there's no stack/type to recover; log the real object.
- **Every other Winston log becomes a breadcrumb**, not just errors.
  `logger.info(...)`/`logger.debug(...)`/`logger.warn(...)` calls you
  already have throughout your app turn into request-trace context
  automatically (capped at 50 per request, same as all other breadcrumbs) —
  no `addBreadcrumb()` calls needed at any of your existing log sites.
- **Pino** — the same detection runs against Pino's internal `write` call.
  An `Error` passed directly, or under an `err`/`error` key, is captured the
  same way. (Pino logs do not currently become breadcrumbs — only Winston.)

Both integrations are **fail-silent**: if the package isn't installed,
detection throws internally and is caught — nothing breaks, and nothing is
patched. Neither library is a dependency of `@vantatrace/sdk`; install
whichever one your project already uses and VantaTrace will find it.

### Masking log metadata

Log metadata pulled in from Winston (the object attached to a captured error
or a log-derived breadcrumb) isn't covered by the backend's generic
password/token/secret-shaped scrubbing — a field like `ConsumerName` or
`CNIC` isn't secret-*shaped*, so it passes through untouched unless you tell
VantaTrace it's sensitive by name:

```javascript
new VantaTrace({
  apiKey: 'YOUR_API_KEY',
  maskingKeys: ['CNIC', 'ConsumerName', 'BankAccountNumber', 'MAName']
});
```

Matching is exact (case-insensitive) against the object's own key names, at
any nesting depth, merged with a small built-in default list (`password`,
`token`, `secret`, `pin`, `mpin`, `cvv`, `ssn`, and similar). If your project
already maintains a masking key list for its own log formatter, reuse the
same list here.

---

## Trace IDs & Log Correlation

Every request gets a `traceId` — generated as soon as `requestHandler()`
runs (not lazily on first error, as in earlier versions), so it's available
for the whole request lifecycle, not just after something fails. Every
error captured within that request's `AsyncLocalStorage` scope carries the
same ID, which is what lets the dashboard show "these 3 error events all
came from the same request."

You can stamp the same ID onto your own application logs so a VantaTrace
event and the surrounding log lines can be correlated later:

```javascript
import { VantaTrace } from '@vantatrace/sdk';

logger.info('Processing checkout', {
  traceId: VantaTrace.getActiveTraceId() // undefined outside an active request
});
```

`getActiveTraceId()` is a static method — call it as `VantaTrace.getActiveTraceId()`,
not on an instance.

### Distributed tracing across services (W3C Trace Context)

The `traceId` above isn't just an internal label — it's propagated using the
[W3C Trace Context](https://www.w3.org/TR/trace-context/) standard, so a
trace continues correctly across a service boundary instead of restarting
at every hop:

- **Extraction.** If an incoming request carries a valid `traceparent`
  header (`00-{32-hex trace-id}-{16-hex parent-id}-{2-hex flags}`),
  `requestHandler()` reuses that trace ID rather than generating a new one,
  and records the incoming span as `context.parentSpanId`. A malformed or
  absent header just starts a fresh trace, same as before.
- **Injection.** Every outbound HTTP/HTTPS call made during that request
  (via the same monkey-patch that records HTTP breadcrumbs/spans)
  automatically carries a `traceparent` header built from the active trace
  ID and this service's own new span ID — so a downstream service (whether
  it's VantaTrace-instrumented or any other W3C-compliant tracing system)
  continues the same trace. A `traceparent` header your own code already
  set on the request is never overwritten.
- Only the standards-compliant `traceparent` header is honored for
  continuing a trace — `x-trace-id`/`x-correlation-id`/`x-request-id` stay
  informational only (`context.correlationId`), since their format isn't
  guaranteed to be a valid 32-hex trace ID, and feeding an arbitrary value
  into a spec-compliant header handed to a downstream service would just
  push a malformed value further down the chain.

`context.spanId` (this service's own span within the trace),
`context.parentSpanId` (the upstream caller's span, if any), and
`context.traceparent` (the full header value) are all available on every
captured error. The parsing/generation utilities are also exported directly
if you need them outside Express (a message queue consumer, a custom
protocol):

```javascript
import { parseTraceParent, buildTraceParent, generateTraceId, generateSpanId } from '@vantatrace/sdk';
```

---

## Global Process Handlers

`vantaTrace.initGlobalHandlers()` wires up three independent capture systems
in one call:

1. **`uncaughtException`** — native/runtime errors that escape every catch
   block (typos, undefined references). VantaTrace captures the error, then
   gives the batched transport ~1.5 seconds to flush before the process
   exits (Node's own crash-recovery behavior for uncaught exceptions is
   otherwise immediate).
2. **`unhandledRejection`** — async/await errors that are thrown or
   generated inside an async catch block and never awaited/caught further
   up. Non-`Error` rejection reasons are wrapped in an `Error` before
   capture.
3. **Logger interception** — `console.error`/`log`/`warn`/`info` (see
   [Breadcrumbs](#breadcrumbs)), plus [Winston and Pino](#logger-integrations-winston--pino)
   if installed.

All three share the same deduplication guard as `captureException()`, so an
error that reaches multiple handlers (e.g. logged via `console.error` and
then rethrown to `uncaughtException`) is only ever reported once.

---

## Security & Data Redaction

Sensitive fields are automatically redacted — in the request body, the query
string, and HTTP headers alike — using a case-insensitive substring match
against the field/header name:

```
password · token · secret · auth (matches authorization, proxy-authorization)
pin (matches mpin, x-mpin) · creditcard · cvv · cookie (matches set-cookie)
api-key (matches x-api-key)
```

A field or header matching any of these is replaced with `[REDACTED]` before
the event ever leaves your process — this happens in `requestHandler()`
itself, independent of any additional scrubbing your VantaTrace backend
applies as defense-in-depth. This is why an `X-MPIN` header is redacted the
same way a `password` body field is.

---

## Performance, Reliability & Internals

VantaTrace is built to disappear under normal operation and degrade
gracefully under load, rather than add risk to your app:

- **Batched, non-blocking transport.** Captured events are queued per
  (API URL, API key) and flushed as a single HTTP request: immediately for
  `critical` severity or once a batch reaches 50 events, otherwise on a
  500ms timer. Sending happens via `setImmediate`, deferred out of the
  current event-loop turn.
- **Compression.** Batches larger than 10KB are gzipped before sending
  (falls back to plaintext if compression fails for any reason).
- **Connection reuse.** Keep-alive HTTP/HTTPS agents pool TCP/TLS
  connections, and a 30-second in-memory DNS cache avoids repeated lookups
  — both reduce per-request overhead for high-frequency error reporting.
- **Retry with backoff.** A failed batch send is retried up to 3 times, with
  exponential backoff plus jitter between attempts (`min(cap, base * 2^attempt)`
  + a proportional random jitter, capped at 5 seconds) — staggers retrying
  clients apart instead of retrying instantly, which would otherwise pile
  on an already-struggling ingestion endpoint right when it's recovering
  from an outage. A request timeout now also triggers a retry (previously
  only network errors and non-2xx responses did — a timed-out batch was
  silently dropped with no retry at all).
- **Backpressure.** A soft ceiling (50 concurrent in-flight batches) drops
  non-critical events; a hard ceiling (100) drops everything, protecting
  your process from unbounded memory growth if the ingestion endpoint is
  unreachable for an extended period.
- **Automatic kill-switch.** If the backend reports your API key as
  disabled (HTTP 403, or an explicit disabled flag), the SDK stops sending
  for 5 minutes before re-checking — no wasted retries against a key you've
  intentionally revoked.
- **Fingerprinting.** Errors are grouped by an MD5 hash of their name,
  message, and the first 4 lines of their normalized stack trace — enough
  to ignore incidental line-number drift deep in library code while still
  treating genuinely different call sites as separate issues.
- **Lightweight system telemetry.** CPU/memory/load-average snapshots are
  sampled on a background 10-second timer (`.unref()`'d, so it never keeps
  your process alive on its own) rather than queried synchronously on every
  captured error.
- **SQL query sanitization for DB spans.** Auto-instrumented `pg`/`mysql2`
  queries have their string, numeric, and hex literals stripped (replaced
  with `?`) before the query text is used as a span name — a
  non-parameterized query (or one logged with values already interpolated)
  otherwise embeds real parameter values directly, which for a typical
  schema means phone numbers, national ID numbers, PINs, and account
  numbers landing verbatim in captured telemetry. This is a fast
  regex-based scrub, not a full SQL parser — it's a span label, not
  something re-executed, so occasionally over-redacting a harmless
  identifier is an accepted tradeoff for never under-redacting a real value.

### Rate limiting, sampling & drop visibility

Two independent volume controls exist so a downstream outage that suddenly
fails every request doesn't turn into an unbounded event storm — and, unlike
the transport's reactive backpressure ceiling above, both are checked
*before* the expensive part of a capture (system context, payload
construction), and both are fully visible in production, not just under
`debug: true`:

```javascript
new VantaTrace({
  apiKey: 'YOUR_API_KEY',
  rateLimit: {
    maxPerMinute: 1000,               // global cap across all fingerprints (default)
    maxPerFingerprintPerMinute: 150,  // one repeating error can't crowd out others (default)
    sampleRate: 1                    // 0..1, an additional lever for high-baseline-failure services (default: no sampling)
  }
});
```

- **Global cap** protects overall volume regardless of how many distinct
  errors are firing — the primary defense during an incident.
- **Per-fingerprint cap** ensures one repeating error doesn't consume the
  entire global budget, so you still see *other*, different failures
  happening in the same window.
- **`sampleRate`** is an additional, optional dial for services with a high
  sustained baseline of expected failures, applied after both caps.
- Set any cap to `false` to disable it.

**Drop visibility.** Every path that silently discards an event — rate
limiting, sampling, transport backpressure, an exhausted retry, a disabled
API key — increments a counter. A background reporter (independent of
`debug`) logs a summary via `console.warn` every 60 seconds, but only when
something was actually dropped:

```
[VantaTrace] WARNING: 340 event(s) dropped in the last ~60s — rateLimitGlobal=200,
rateLimitFingerprint=140, sampledOut=0, backpressureSoft=0, backpressureHard=0,
apiKeyDisabled=0, sendFailureExhausted=0. Call getDropStats() to monitor this programmatically.
```

Or poll it yourself for alerting:

```javascript
const stats = vantaTrace.getDropStats();
// { rateLimitGlobal, rateLimitFingerprint, sampledOut, backpressureSoft,
//   backpressureHard, apiKeyDisabled, sendFailureExhausted, total }
if (stats.total > 0) {
  myMetrics.gauge('vantatrace.dropped_events', stats.total);
}
```

---

## TypeScript Support

The SDK is written in TypeScript and ships compiled `.d.ts` declarations —
`VantaTrace`'s public methods are fully typed, including `captureException`'s
context parameter (`VantaTraceContext`).

You don't need to import that type explicitly to get type-checking: passing
an inline object literal is checked structurally against the method
signature either way —

```typescript
vantaTrace.captureException(error, {
  userId: 'user_123',
  severity: 'warning' // typo here (e.g. 'warn') is a compile error
});
```

— which covers the overwhelming majority of real usage.

---

## API Reference

| Method | Description |
| --- | --- |
| `new VantaTrace(options)` | Construct an instance. See [Configuration Reference](#configuration-reference). |
| `.captureException(error, context?)` | Capture an error with optional context overrides. Default severity: `critical`. |
| `.captureCritical(error, context?)` | Shortcut for `captureException(error, { ...context, severity: 'critical' })`. |
| `.captureWarning(error, context?)` | Shortcut for `severity: 'warning'`. |
| `.captureInfo(error, context?)` | Shortcut for `severity: 'info'`. |
| `.requestHandler()` | Express middleware — mount first, establishes per-request context. |
| `.errorHandler()` | Express middleware — mount last, captures unhandled route errors. |
| `.expressMiddleware()` | **Deprecated.** Alias for `.errorHandler()`. |
| `.initGlobalHandlers()` | Wires up `uncaughtException`, `unhandledRejection`, and logger interception. See [Global Process Handlers](#global-process-handlers). |
| `.addBreadcrumb(breadcrumb)` | Record a manual breadcrumb on the active request. See [Breadcrumbs](#breadcrumbs). |
| `.startSpan(type, name)` | Starts a timed span (`'http' \| 'db' \| 'redis' \| 'custom'`); call the returned `.end()` when the operation completes. |
| `.getDropStats()` | Snapshot of events dropped since the last periodic report (rate limiting, sampling, backpressure, disabled key, exhausted retries). See [Rate limiting, sampling & drop visibility](#rate-limiting-sampling--drop-visibility). |
| `.maskData(value)` | Redacts `maskingKeys`-matched fields from an arbitrary object — used internally by the Winston integration, exposed for your own use. |
| `.shutdown()` | Detaches the V8 inspector watcher (if `autoCapture.caughtExceptions` was enabled) and stops the drop-visibility reporter. Safe to call multiple times. |
| `VantaTrace.getActiveTraceId()` | **Static.** Returns the active request's trace ID, or `undefined` outside a request. See [Trace IDs](#trace-ids--log-correlation). |

---

## Multiple Instances / Microservices

Construct one `VantaTrace` instance per process — typically once, in your
entrypoint — and reuse it everywhere in that service via your own module
export or dependency injection. For a fleet of microservices, give each
service its own project API key (or the same key with a different
`serviceName`) and its own instance.

> [!NOTE]
> The [Babel plugin](#zero-code-auto-capture-babel-plugin)'s injected
> `captureExceptionGlobal()` calls resolve to a single process-wide
> singleton: **the first `VantaTrace` instance constructed wins.**
> Constructing a second instance in the same process logs a warning and
> does not replace the registered singleton — direct `vantaTrace.captureException()`
> calls on that second instance still work normally, only the
> Babel-injected auto-capture is affected.

---

## Troubleshooting

**No events showing up on the dashboard?**
- Confirm `apiKey` is set and correct — with no key, the SDK silently runs
  in dry-run mode (set `debug: true` to see what it would have sent).
- Check for a "API key is temporarily disabled" debug log — see the
  kill-switch note in [Performance, Reliability & Internals](#performance-reliability--internals).
- If you're relying on `autoCapture.http5xx`/`caughtExceptions` for errors
  swallowed by a `try/catch`, confirm the request actually returned 5xx —
  the safety net only fires for failed requests by default.

**`userId`/`appVersion` always empty?** See the callouts under
[Automatic Context Enrichment](#automatic-context-enrichment) — both are
extracted from the incoming request (auth middleware / `X-APP-VERSION`
header respectively), not inferred by VantaTrace.

**`SyntaxError: Cannot use import statement outside a module` after adding
the Babel plugin?** See the note under
[Zero-Code Auto-Capture](#zero-code-auto-capture-babel-plugin) — add a
module transform (`@babel/preset-env`) or set `sourceType: "unambiguous"`.

---

## License

MIT
