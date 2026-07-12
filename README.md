# 🚀 VantaTrace Node.js SDK

**VantaTrace** is a lightweight, high-performance observability SDK for
Node.js microservices and Express.js APIs.

It provides real-time **exception tracking, structured telemetry, and
runtime context capture**, enabling developers to detect, group, and
debug production issues with minimal overhead.

Designed for modern distributed systems, VantaTrace runs fully
asynchronously and never blocks your application runtime.

------------------------------------------------------------------------

## ✨ Key Features

-   ⚡ Zero-blocking architecture --- async ingestion pipeline\
-   🧠 Smart error grouping (fingerprinting) --- deduplicates identical
    failures\
-   🔍 Rich runtime context --- request, system, and environment
    metadata\
-   🔒 Secure by default --- automatic redaction of sensitive data\
-   🌐 Multi-service support --- built for microservices architecture\
-   📊 Structured telemetry --- normalized event payloads\
-   🧩 Express.js integration --- plug-and-play middleware

------------------------------------------------------------------------

## 📦 Installation

``` bash
npm install @vantatrace/sdk
```

------------------------------------------------------------------------

## ⚡ Quick Start

First, sign up and get your API keys from [https://vantatrace.com](https://vantatrace.com) to get started.

### 1. Initialize SDK

``` javascript
import { VantaTrace } from '@vantatrace/sdk';

const vantaTrace = new VantaTrace({
  apiKey: 'YOUR_PROJECT_API_KEY', // Get your API Key from https://vantatrace.com (starts with ep_live_ or ep_test_)
  serviceName: 'checkout-service', // optional — labels events on the dashboard (defaults to your project name)
  debug: false
});
```

------------------------------------------------------------------------

### 2. Enable Global Error Tracking

``` javascript
vantaTrace.initGlobalHandlers();
```

------------------------------------------------------------------------

### 3. Express Middleware Integration

VantaTrace uses a decoupled two-part middleware design for Express to ensure complete request context tracking without leaking scopes:

1. **`requestHandler()`**: Mounted at the very top of your middleware stack (before any routes or body parsers) to establish the `AsyncLocalStorage` request context.
2. **`errorHandler()`**: Mounted at the very bottom of your middleware stack (after all routes and controllers) to capture unhandled exceptions under the correct request context.

``` javascript
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
> `vantaTrace.expressMiddleware()` is deprecated but preserved as an alias to `errorHandler()` for backward compatibility.

------------------------------------------------------------------------

### 4. Automatic Capture of Errors Handled in try/catch (Runtime)

Errors handled inside a local `try/catch` never reach the error middleware:

``` javascript
app.get('/api/v1/check', (req, res) => {
  try {
    a; // ReferenceError
  } catch (error) {
    res.status(500).json({ error: 'Order failed' }); // silently lost?
  }
});
```

VantaTrace captures these automatically — no `captureException()` call and no
per-catch-block changes required — through two layers:

#### 4a. Failed-request safety net (enabled by default)

When a request finishes with a **5xx status** and no error was reported for it,
the SDK emits a synthetic `HttpServerError` event carrying the method, route,
status code, and full request context (`metadata.captureStrategy: 'http5xx'`).
The failure becomes visible on the dashboard even though the original error
object was swallowed. Disable with:

``` javascript
new VantaTrace({ apiKey, autoCapture: { http5xx: false } });
```

#### 4b. Deep capture via the V8 inspector (opt-in)

JavaScript has no language-level hook for caught exceptions — `try/catch` is
resolved entirely inside the V8 VM (this is why Sentry and Bugsnag require
manual capture calls for handled errors). The one runtime mechanism that can
observe them is the V8 inspector protocol: with pause-on-exceptions enabled,
V8 notifies an in-process `node:inspector` session at **every throw site,
before the catch block runs** — including engine-generated errors like
`ReferenceError` and `TypeError`. VantaTrace uses this to recover the *real*
error object with its full stack trace and request context:

``` javascript
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

``` javascript
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
and then reaches `errorHandler()` (or a manual `captureException`) is reported
exactly once.

**Performance.** Near-zero overhead while nothing throws; roughly **0.3–0.5ms
per thrown exception** while enabled (measured on Node 22). That is negligible
when exceptions are exceptional, but measurable for code that uses throw/catch
as control flow — which is why this layer is opt-in, the same trade-off Sentry
documents for its `captureAllExceptions` local-variables mode. For
zero-runtime-overhead capture, use the Babel plugin (next section) instead.

Call `vantaTrace.shutdown()` on graceful shutdown to detach the inspector
session (optional; safe to call multiple times).

------------------------------------------------------------------------

### 5. Manual Error Capturing

``` javascript
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

------------------------------------------------------------------------

### 6. Zero-Code Auto-Capture (Babel Plugin)

VantaTrace includes a Babel plugin that automatically injects an error capture
call into every `try/catch` block in your codebase at build time — no manual
`vantaTrace.captureException()` calls required, and no per-file imports to
remember. It resolves to whichever `VantaTrace` instance you constructed in
your entrypoint (see step 1) automatically.

**Setup in `.babelrc` or `babel.config.js`:**

```json
{
  "presets": ["@babel/preset-env"],
  "plugins": ["@vantatrace/sdk/babel-plugin"]
}
```

> [!NOTE]
> The plugin auto-imports its runtime helper as an ESM `import` or a CommonJS
> `require()` depending on Babel's detected `sourceType` for each file. A module
> transform like `@babel/preset-env` (or setting `sourceType: "unambiguous"`) makes
> sure that import is correctly compiled down for CommonJS codebases — without one,
> a plain CommonJS file with no `import`/`export` syntax will otherwise get an ESM
> `import` injected into it and fail at runtime with `SyntaxError: Cannot use import
> statement outside a module`.

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

------------------------------------------------------------------------

## ⚙️ Severity Levels

``` javascript
vantaTrace.captureCritical(error);
vantaTrace.captureWarning(error);
vantaTrace.captureInfo(error);
```

------------------------------------------------------------------------

## 🧠 How It Works

Application Error → SDK Capture → Context Enrichment → Fingerprinting →
Async Queue → Ingestion API → Dashboard

------------------------------------------------------------------------

## 🔒 Security

Sensitive fields are automatically redacted: password, token,
authorization, cookie, x-api-key

------------------------------------------------------------------------

## ⚡ Performance

-   \<1ms overhead
-   Async non-blocking execution
-   Batched ingestion

------------------------------------------------------------------------

## 📊 Architecture

Microservice → SDK → Ingestion API → Fingerprinting Engine → Dashboard
