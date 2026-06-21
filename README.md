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

First, sign up and get your API keys from [https://api.vantatrace.com](https://api.vantatrace.com) to get started.

### 1. Initialize SDK

``` javascript
import { VantaTrace } from '@vantatrace/sdk';

const vantaTrace = new VantaTrace({
  apiKey: 'YOUR_PROJECT_API_KEY', // Get your API Key from https://api.vantatrace.com (starts with ep_live_ or ep_test_)
  serviceName: 'order-service',
  // Note: environment is automatically determined from your API key prefix (ep_live_ -> live, ep_test_ -> test)
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

``` javascript
import express from 'express';

const app = express();

app.get('/checkout', () => {
  throw new Error('Payment gateway timeout');
});

app.use(vantaTrace.expressMiddleware());

app.use((err, req, res, next) => {
  res.status(500).send('Internal Server Error');
});
```

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
