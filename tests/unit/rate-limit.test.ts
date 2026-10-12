import { describe, expect, it } from "vitest";
import { RateLimiter } from "@/lib/server/rate-limit";

describe("RateLimiter", () => {
  it("allows `limit` hits per window, then refuses until the window ends", () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect([l.take("a"), l.take("a"), l.take("a"), l.take("b")]).toEqual([true, true, false, true]);
    t = 1000;
    expect(l.take("a")).toBe(true);
  });

  it("isLimited reports without counting a hit", () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect(l.isLimited("a")).toBe(false);
    l.take("a");
    expect(l.isLimited("a")).toBe(false);
    l.take("a");
    expect([l.isLimited("a"), l.isLimited("a")]).toEqual([true, true]);
    t = 1000;
    expect(l.isLimited("a")).toBe(false);
  });
});
