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

### 4. Manual Error Capturing

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
