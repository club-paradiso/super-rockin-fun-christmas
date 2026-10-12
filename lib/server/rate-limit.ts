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
