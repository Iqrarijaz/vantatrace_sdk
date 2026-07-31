/**
 * Proactive volume control for captured events, independent of (and applied
 * before) the transport's reactive backpressure ceiling. Two knobs:
 *
 * - A global cap (events/minute across the whole process) — the primary
 *   defense during an incident where a downstream dependency fails and
 *   every request starts erroring at once.
 * - A per-fingerprint cap — so one repeating error can't consume the whole
 *   global budget and crowd out visibility into other, different failures
 *   happening in the same window.
 *
 * Both use a simple fixed 60-second window (not a sliding window/token
 * bucket) — cheap (one Map lookup per check) and precise enough for this
 * purpose; the defaults are chosen to be generous for normal traffic and
 * protective during a storm, not to shape traffic smoothly.
 */

export interface RateLimitOptions {
  /** Max captured events per minute, globally, across all fingerprints. `false` disables the global cap. Default: 1000 (~16.7/sec). */
  maxPerMinute?: number | false;
  /** Max captured events per minute for a single error fingerprint. `false` disables the per-fingerprint cap. Default: 150 (2.5/sec). */
  maxPerFingerprintPerMinute?: number | false;
  /** Fraction of events (0..1) allowed through after rate-limit checks pass — an additional lever for services with a high sustained baseline of expected failures. Default: 1 (no sampling). */
  sampleRate?: number;
}

export interface DropStats {
  rateLimitGlobal: number;
  rateLimitFingerprint: number;
  sampledOut: number;
}

const DEFAULT_MAX_PER_MINUTE = 1000;
const DEFAULT_MAX_PER_FINGERPRINT_PER_MINUTE = 150;
const WINDOW_MS = 60000;

export function createRateLimiter(options: RateLimitOptions = {}) {
  const maxPerMinute = options.maxPerMinute === false ? Infinity : (options.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE);
  const maxPerFingerprint = options.maxPerFingerprintPerMinute === false
    ? Infinity
    : (options.maxPerFingerprintPerMinute ?? DEFAULT_MAX_PER_FINGERPRINT_PER_MINUTE);
  const sampleRate = options.sampleRate === undefined ? 1 : Math.max(0, Math.min(1, options.sampleRate));

  let windowStart = Date.now();
  let globalCount = 0;
  const fingerprintCounts = new Map<string, number>();

  const drops: DropStats = { rateLimitGlobal: 0, rateLimitFingerprint: 0, sampledOut: 0 };

  const rollWindowIfNeeded = () => {
    const now = Date.now();
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now;
      globalCount = 0;
      fingerprintCounts.clear();
    }
  };

  return {
    /** Returns true if this event should proceed to capture/send; increments the relevant drop counter otherwise. */
    shouldAllow(fingerprint: string): boolean {
      rollWindowIfNeeded();

      if (globalCount >= maxPerMinute) {
        drops.rateLimitGlobal++;
        return false;
      }

      const fpCount = fingerprintCounts.get(fingerprint) || 0;
      if (fpCount >= maxPerFingerprint) {
        drops.rateLimitFingerprint++;
        return false;
      }

      if (sampleRate < 1 && Math.random() >= sampleRate) {
        drops.sampledOut++;
        return false;
      }

      globalCount++;
      fingerprintCounts.set(fingerprint, fpCount + 1);
      return true;
    },

    getDropStats(): DropStats {
      return { ...drops };
    },

    /** Resets drop counters only (not the rate-limit window/counts themselves) — used after each periodic summary report. */
    resetDropStats(): void {
      drops.rateLimitGlobal = 0;
      drops.rateLimitFingerprint = 0;
      drops.sampledOut = 0;
    }
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
