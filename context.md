# VantaTrace SDK Context & Technical Reference

This document provides a comprehensive technical overview of the `@vantatrace/sdk` Node.js package, explaining its architecture, configurations, public APIs, integration patterns, and internal safety mechanisms.

---

## 📂 SDK Module Structure

The SDK is located in the `sdk/` subdirectory. Its codebase is structured as follows:

- **`src/types.ts`**: Defines typescript interfaces for configuration (`VantaTraceOptions`, `AutoCaptureOptions`, `CaughtExceptionCaptureOptions`, `RateLimitOptions`), context payload (`VantaTraceContext`), breadcrumbs, spans, and the final payload structure (`ErrorPayload`).
- **`src/index.ts`**: The main entry point containing the core `VantaTrace` class, which coordinates initialization, context management, monkey patching, and exception capturing.
- **`src/context.ts`**: Telemetry and system metadata collection (memory, CPU, load averages, event loop delay/lag).
- **`src/transport.ts`**: Asynchronous batching, gzip compression, HTTP/HTTPS keep-alive connection pooling, exponential retry with jitter, backpressure queues, and the automatic disabled-key kill switch.
- **`src/caught-exceptions.ts`**: Implements the V8 inspector watcher via `node:inspector` to intercept caught exceptions from `try/catch` blocks at runtime.
- **`src/instrumentation.ts`**: Best-effort automatic patching of DB/Redis clients (`pg`, `mysql2`, `ioredis`) to record timed query spans.
- **`src/masking.ts`**: Contextual data masking for PII/secrets (passwords, tokens, CVVs, cookies, PINs, bank accounts, CNIC) using substring case-insensitive matching.
- **`src/rateLimiter.ts`**: Implements global and per-fingerprint rate limiting with sampling.
- **`src/requestContext.ts`**: Helper to build request-level context from Express req/res objects.
- **`src/tracecontext.ts`**: Handles parsing/propagation of W3C `traceparent` headers for distributed tracing.
- **`src/consoleInstrumentation.ts`**: Monkey-patches global `console` output to capture logs as breadcrumbs/exceptions.
- **`src/httpInstrumentation.ts`**: Monkey-patches global Node `http`/`https` calls to capture outgoing request breadcrumbs.
- **`src/winston.ts`**: Custom Winston logger transport integration.
- **`src/pino.ts`**: Pino logger patch interceptor.
- **`babel-plugin.js`**: A Babel AST transform to compile-time inject exception reporting to every `try/catch` block.

---

## ⚡ Architectural Core

### 1. Zero-Blocking Asymmetrical Transport
- Captured exceptions never block the Node event loop or delay HTTP response paths.
- Payloads are queued and flushed asynchronously in batches using `setImmediate()`.
- Flushes immediately on `critical` severity exceptions, or when the queue reaches 50 events, or on a 500ms fallback timer.
- Batches larger than 10KB are automatically compressed using native Gzip compression.

### 2. Self-Defending Performance Limits
- **Backpressure Soft Cap**: Caps at 50 concurrent in-flight batches, dropping non-critical telemetry.
- **Backpressure Hard Cap**: Caps at 100 concurrent in-flight batches, dropping all telemetry to prevent memory exhaustion when ingestion is down.
- **Automatic Kill-Switch**: If ingestion replies with `403 Forbidden` (disabled key), the SDK halts transmission for 5 minutes before checking again.
- **Retry Logic**: Failed batch sends are retried up to 3 times with exponential backoff and proportional randomized jitter (capped at 5 seconds) to avoid thundering herd problem.

### 3. Rate Limiting, Sampling & Visibility
- Checked proactively before context aggregation or payload building:
  - **Global Limit**: Default `1000` events/minute.
  - **Fingerprint Limit**: Default `150` events/minute per unique error signature.
  - **Sample Rate**: Decimal threshold (0 to 1) applied post-rate limits.
- **Drop Visibility**: Drop counts are logged every 60 seconds when events are discarded (`getDropStats()` exposes these programmatically).

### 4. Distributed Tracing (W3C Trace Context)
- Reuses or propagates `traceparent` headers matching the W3C spec (`00-{traceId}-{parentId}-{flags}`).
- Ensures trace IDs are preserved across network boundaries when calling downstream microservices.
- Custom headers (`x-correlation-id`, `x-request-id`) are retained in metadata but not used as distributed trace headers.

---

## ⚙️ Configuration Reference (`VantaTraceOptions`)

Options accepted by the `new VantaTrace(options)` constructor:

```typescript
export interface VantaTraceOptions {
  apiKey: string;                         // REQUIRED. SDK runs in Dry-Run mode if omitted.
  debug?: boolean;                        // Logs SDK internals to console (default: false)
  apiUrl?: string;                        // Custom ingestion URL (default: https://api.vantatrace.com/api/events)
  autoCapture?: AutoCaptureOptions;       // Opt-in/out capture settings
  maskingKeys?: string[];                 // Custom key names to redact (merged with defaults)
  rateLimit?: RateLimitOptions;           // Volume cap settings
}
```

### AutoCapture Config (`AutoCaptureOptions`)
- **`http5xx`** (`boolean`): Generates a synthetic error when a request ends with a `5xx` status but no exception was reported. (Default: `true`)
- **`httpClientErrors`** (`boolean | { exclude?: number[] }`): Generates a synthetic `HttpClientError` warning for eligible `4xx` responses. (Default: `true`, excluding `[401, 404]`)
- **`caughtExceptions`** (`boolean | CaughtExceptionCaptureOptions`): Watcher using `node:inspector` to trap errors handled inside catch blocks at the engine level. (Default: `false`)

> [!CAUTION]
> `caughtExceptions` adds ~0.3ms–0.5ms per thrown exception. When `NODE_ENV=production`, it is **automatically disabled** unless `caughtExceptions.allowInProduction: true` is explicitly configured.

---

## 🛠️ Public API Surface

### 1. Instance Methods
- **`requestHandler()`**: Top-level Express middleware that establishes the `AsyncLocalStorage` scope and trace ID.
- **`errorHandler()`**: Bottom-level Express error middleware to catch and report escaping route exceptions.
- **`initGlobalHandlers()`**: Installs process-level handlers for `uncaughtException`, `unhandledRejection`, and patches global console output plus Winston/Pino logs.
- **`captureException(error, context?)`**: Core exception capturer. Automatically deduplicates repeating object references.
- **`captureCritical(error, context?)`**, **`captureWarning(error, context?)`**, **`captureInfo(error, context?)`**: Quick severity shorthand helpers.
- **`addBreadcrumb(breadcrumb)`**: Manually append custom telemetry steps to the active request context (max 50, oldest shifted out).
- **`startSpan(type, name)`**: Records timed sub-operations (HTTP, Database, Redis, Custom) to build a trace waterfall diagram on the dashboard.
- **`getDropStats()`**: Programmatic fetch of rate-limit and backpressure drop rates.
- **`shutdown()`**: Graceful tear down (detaches inspectors and clears background interval timers).

### 2. Static Methods & Exports
- **`VantaTrace.getActiveTraceId()`**: Retrieves the active trace ID from AsyncLocalStorage.
- **`parseTraceParent(header)`**, **`buildTraceParent(traceId, spanId, flags)`**: Serializers/parsers for W3C distributed tracing context.
- **`generateTraceId()`**, **`generateSpanId()`**: Hex generators for trace (32-hex) and span (16-hex) scopes.

---

## 📦 Zero-Code Compilation Integration (Babel Plugin)

To capture try/catch blocks without inspector overhead or manual `captureException` calls, configure the Babel plugin in `.babelrc` or `babel.config.js`:

```json
{
  "presets": ["@babel/preset-env"],
  "plugins": ["@vantatrace/sdk/babel-plugin"]
}
```

### Transformer Behavior
Converts:
```javascript
try {
  executeTask();
} catch (error) {
  res.status(500).json({ error: 'Failed' });
}
```
Into:
```javascript
import { captureExceptionGlobal } from '@vantatrace/sdk/runtime';
try {
  executeTask();
} catch (error) {
  captureExceptionGlobal(error);
  res.status(500).json({ error: 'Failed' });
}
```
*Note: Uses standard CommonJS `require()` fallback when Babel detects CommonJS source files.*

### Exclusion Rules
The plugin skips injection if:
1. The catch has no binding (e.g., `catch { ... }`).
2. The catch is destructured (e.g., `catch ({ message })`).
3. There is an explicit `captureException` call already inside the catch block.
4. The comment `// vantatrace-ignore` is placed above the `try` block or on the `catch` line.
