import * as os from 'os';

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
  loadavg: [0, 0, 0] as number[]
};

// Tracks process start time for lightweight uptime calculations (avoids process.uptime() native calls)
const processStartTime = Date.now();

// Track if sampling interval has been initialized
let samplingInterval: NodeJS.Timeout | null = null;

/**
 * Samples the dynamic metrics (memory usage, free memory, load averages).
 */
export function sampleDynamicContext() {
  try {
    const memoryUsage = process.memoryUsage();
    dynamicContext = {
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external
      },
      freeMem: os.freemem(),
      loadavg: os.loadavg()
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
    uptime: uptimeSeconds
  };
}
