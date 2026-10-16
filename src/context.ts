import * as os from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';

// Cache static system context at load time
const staticContext = {
  nodeVersion: process.version,
  hostname: os.hostname(),
  pid: process.pid,
  platform: os.platform(),
  arch: os.arch(),
  totalMem: os.totalmem()
};

// Store dynamic context (defaults)
let dynamicContext = {
  memory: {
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0
  },
  freeMem: 0,
  loadavg: [0, 0, 0] as number[],
  cpuPercent: 0,
  eventLoopLagMs: 0
};

// Tracks process start time for lightweight uptime calculations (avoids process.uptime() native calls)
const processStartTime = Date.now();

// Track if sampling interval has been initialized
let samplingInterval: NodeJS.Timeout | null = null;

// CPU% is a delta metric — needs the previous sample's cumulative usage and
// wall-clock time to compute (time spent on CPU) / (time elapsed) * 100.
let lastCpuUsage: NodeJS.CpuUsage = process.cpuUsage();
let lastCpuSampleTime = Date.now();

// Event loop lag: a rolling histogram of the delay between scheduled and
// actual timer callbacks. Node 11.10+; guarded since some runtimes (older
// Node, non-Node environments) don't expose perf_hooks.monitorEventLoopDelay.
let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
try {
  if (typeof monitorEventLoopDelay === 'function') {
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
  }
} catch (err) {
  // Fail silently — event loop lag becomes 0 rather than breaking the SDK.
  eventLoopHistogram = null;
}

/**
 * Samples the dynamic metrics (memory usage, free memory, load averages, CPU%, event loop lag).
 */
export function sampleDynamicContext() {
  try {
    const memoryUsage = process.memoryUsage();

    const now = Date.now();
    const currentCpuUsage = process.cpuUsage();
    const elapsedMs = now - lastCpuSampleTime;
    const cpuDeltaMs = ((currentCpuUsage.user - lastCpuUsage.user) + (currentCpuUsage.system - lastCpuUsage.system)) / 1000;
    const cpuPercent = elapsedMs > 0 ? Math.max(0, Math.round((cpuDeltaMs / elapsedMs) * 10000) / 100) : 0;
    lastCpuUsage = currentCpuUsage;
    lastCpuSampleTime = now;

    let eventLoopLagMs = 0;
    if (eventLoopHistogram) {
      // mean is in nanoseconds; NaN when no samples have landed yet.
      eventLoopLagMs = Number.isFinite(eventLoopHistogram.mean) ? Math.round((eventLoopHistogram.mean / 1e6) * 100) / 100 : 0;
      eventLoopHistogram.reset();
    }

    dynamicContext = {
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external
      },
      freeMem: os.freemem(),
      loadavg: os.loadavg(),
      cpuPercent,
      eventLoopLagMs
    };
  } catch (err) {
    // Fail silently in case of issues querying memory/OS stats
  }
}

/**
 * Starts the background telemetry sampling interval.
 * Uses .unref() so it does not prevent Node.js from exiting cleanly.
 */
export function startTelemetrySampling(intervalMs: number = 10000) {
  if (samplingInterval) return;
  
  // Sample immediately on start
  sampleDynamicContext();

  samplingInterval = setInterval(sampleDynamicContext, intervalMs);
  if (samplingInterval && typeof samplingInterval.unref === 'function') {
    samplingInterval.unref();
  }
}

/**
 * Resolves the aggregated system context from pre-cached static and dynamic values.
 * Extremely fast and non-blocking.
 */
export function getSystemContext() {
  // If the sampling interval has not been started, ensure we at least sample once
  if (!samplingInterval) {
    sampleDynamicContext();
  }

  // Lightweight math-based uptime computation (avoiding native system time calls)
  const uptimeSeconds = Math.round((Date.now() - processStartTime) / 1000);

  return {
    nodeVersion: staticContext.nodeVersion,
    hostname: staticContext.hostname,
    pid: staticContext.pid,
    platform: staticContext.platform,
    arch: staticContext.arch,
    memory: {
      rss: dynamicContext.memory.rss,
      heapTotal: dynamicContext.memory.heapTotal,
      heapUsed: dynamicContext.memory.heapUsed,
      external: dynamicContext.memory.external,
      freeMem: dynamicContext.freeMem,
      totalMem: staticContext.totalMem
    },
    loadavg: dynamicContext.loadavg,
    uptime: uptimeSeconds,
    cpu: {
      percent: dynamicContext.cpuPercent
    },
    eventLoopLag: dynamicContext.eventLoopLagMs
  };
}
