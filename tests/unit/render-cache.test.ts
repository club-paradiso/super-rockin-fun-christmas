import { describe, expect, it } from "vitest";
import { prefetch, RenderCache, type PrefetchTimers } from "@/lib/kiosk/render-cache";

function manualTimers() {
  const queue: (() => void)[] = [];
  const timers: PrefetchTimers = {
    setTimeout: (fn) => queue.push(fn),
    clearTimeout: () => queue.splice(0),
  };
  return { timers, tick: () => queue.shift()?.(), pending: () => queue.length };
}

describe("RenderCache", () => {
  it("keeps values, drops the least recently used past its limit", () => {
    const cache = new RenderCache<string>(2);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A"); // a is now the most recent
    cache.set("c", "C");
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("makes a value once", () => {
    const cache = new RenderCache<number | null>();
    let made = 0;
    const make = () => (made++, null);
    expect(cache.getOrMake("k", make)).toBeNull();
    expect(cache.getOrMake("k", make)).toBeNull();
    expect(made).toBe(1);
  });
});

describe("prefetch", () => {
  it("runs one job per task, skipping the ones already done", () => {
    const { timers, tick } = manualTimers();
    const ran: string[] = [];
    const job = (id: string, done = false) => ({ done: () => done, run: () => ran.push(id) });
    prefetch([job("a"), job("b", true), job("c")], timers);
    expect(ran).toEqual([]); // nothing in the caller's task
    tick();
    expect(ran).toEqual(["a"]);
    tick();
    expect(ran).toEqual(["a", "c"]);
    tick();
    expect(ran).toEqual(["a", "c"]);
  });

  it("stops when asked and survives a job that throws", () => {
    const { timers, tick, pending } = manualTimers();
    const ran: string[] = [];
    const stop = prefetch(
      [
        {
          done: () => false,
          run: () => {
            throw new Error("WebGL lost");
          },
        },
        { done: () => false, run: () => ran.push("b") },
        { done: () => false, run: () => ran.push("c") },
      ],
      timers,
    );
    tick();
    tick();
    expect(ran).toEqual(["b"]);
    stop();
    expect(pending()).toBe(0);
    tick();
    expect(ran).toEqual(["b"]);
  });
});
