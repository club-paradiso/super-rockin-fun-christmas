/**
 * Fixed-window, in-process rate limiter. Deliberately simple: one or a few kiosks at one event.
 *
 * Limitation: on serverless platforms each instance has its own memory, so the effective limit is
 * per instance, and limits reset on cold start. It still blunts bursts from a single client. The
 * real protections are elsewhere (kiosk auth, 192-bit tokens, long enrollment secret).
 */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when the request is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      this.sweep(t);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  /** True while `key` is over its limit. Does not count as a hit. */
  isLimited(key: string): boolean {
    const entry = this.hits.get(key);
    return !!entry && this.now() - entry.windowStart < this.windowMs && entry.count >= this.limit;
  }

  private sweep(t: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * Staff PIN guessing limits, shared by every route that checks a PIN (admin login, kiosk help).
 * Kept on globalThis: Next.js bundles routes separately, and a per-module limiter would give each
 * route its own five tries. 6 digits = 10^6 PINs; 5 wrong tries per person per 15 min makes
 * guessing take years. Only failures count, so staff can sign in on several devices.
 */
export function staffPinLimits() {
  const g = globalThis as {
    __ftlPinLimits?: { perIp: RateLimiter; failuresPerUser: RateLimiter };
  };
  return (g.__ftlPinLimits ??= {
    perIp: new RateLimiter(20, 15 * 60_000),
    failuresPerUser: new RateLimiter(5, 15 * 60_000),
  });
}

export const limiters = {
  /** Enrollment attempts per client IP. */
  enroll: new RateLimiter(10, 15 * 60_000),
  /** Uploads per kiosk. A real session takes ~1 minute; 30/min is generous. */
  upload: new RateLimiter(30, 60_000),
  /** Consent changes per kiosk. */
  consent: new RateLimiter(60, 60_000),
  /** Guest page + image fetches per client IP. */
  guest: new RateLimiter(120, 60_000),
  /** Operator API calls per client IP. */
  operator: new RateLimiter(20, 60_000),
};
