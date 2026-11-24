import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@/lib/retouch/detector";
import { RetouchError } from "@/lib/retouch/types";

/**
 * The booth's side of skin retouch (components/kiosk/skin-retouch.tsx) and the face finder's
 * load timeout (lib/retouch/detector.ts): two findings of the automated review of PR #80.
 */

interface FakeRetoucher {
  warmUp: ReturnType<typeof vi.fn>;
  retouchBatch: ReturnType<typeof vi.fn>;
  isDisabled: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const fake: { current: FakeRetoucher | null } = { current: null };

vi.mock("@/lib/retouch/browser", () => ({
  createBrowserRetoucher: () => fake.current,
}));

function retoucher(opts: { warm: boolean; disabledAfter?: number }): FakeRetoucher {
  let batches = 0;
  return {
    warmUp: vi.fn(async () => opts.warm),
    retouchBatch: vi.fn(async (images: unknown[]) => {
      batches++;
      return {
        results: images.map((image) => ({ image, retouched: false, metrics: {}, regions: [] })),
        metrics: { photos: [], totalMs: 0, initMs: 0, peakBytes: 0, jsHeapBytes: null },
      };
    }),
    isDisabled: vi.fn(() => opts.disabledAfter !== undefined && batches >= opts.disabledAfter),
    dispose: vi.fn(),
  };
}

const photo = { source: {}, width: 4, height: 3 } as never;

async function mountHook() {
  const { useSkinRetouch } = await import("@/components/kiosk/skin-retouch");
  return renderHook(() => useSkinRetouch(true, "natural"));
}

afterEach(() => {
  fake.current = null;
  vi.useRealTimers();
});

describe("the booth stops offering skin retouch that cannot work (components/kiosk/skin-retouch.tsx)", () => {
  it("the model loaded: offered, and the chosen photos go through the retoucher", async () => {
    fake.current = retoucher({ warm: true });
    const { result } = await mountHook();
    await waitFor(() => expect(fake.current!.warmUp).toHaveBeenCalled());
    expect(result.current.offered).toBe(true);
    await act(() => result.current.stage!.run([photo]));
    expect(fake.current.retouchBatch).toHaveBeenCalledTimes(1);
  });

  it("the model did not load: not offered, and no guest waits on another attempt", async () => {
    fake.current = retoucher({ warm: false });
    const { result } = await mountHook();
    await waitFor(() => expect(result.current.offered).toBe(false));
    const out = await act(() => result.current.stage!.run([photo]));
    expect(fake.current.retouchBatch).not.toHaveBeenCalled();
    expect(out.images).toEqual([photo]);
    expect(result.current.developing).toBe(false);
  });

  it("switched itself off after failures in a row: the next guest is not offered it", async () => {
    fake.current = retoucher({ warm: true, disabledAfter: 1 });
    const { result } = await mountHook();
    await waitFor(() => expect(fake.current!.warmUp).toHaveBeenCalled());
    expect(result.current.offered).toBe(true);
    await act(() => result.current.stage!.run([photo]));
    expect(result.current.offered).toBe(false);
    // The next print is handed straight through.
    const out = await act(() => result.current.stage!.run([photo]));
    expect(fake.current.retouchBatch).toHaveBeenCalledTimes(1);
    expect(out.images).toEqual([photo]);
  });
});

describe("a face finder that loads after the timeout is closed (lib/retouch/detector.ts)", () => {
  it("in time: the finder is handed over and nothing is discarded", async () => {
    const discard = vi.fn();
    await expect(withTimeout(Promise.resolve("finder"), 1000, discard)).resolves.toBe("finder");
    expect(discard).not.toHaveBeenCalled();
  });

  it("too late: init-timeout for the booth, and the late finder goes to discard", async () => {
    vi.useFakeTimers();
    const discard = vi.fn();
    let deliver!: (value: string) => void;
    const work = new Promise<string>((resolve) => (deliver = resolve));
    const pending = withTimeout(work, 1000, discard);
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1001);
    const error = await outcome;
    expect(error).toBeInstanceOf(RetouchError);
    expect((error as RetouchError).code).toBe("init-timeout");
    deliver("late finder");
    await vi.advanceTimersByTimeAsync(0);
    expect(discard).toHaveBeenCalledWith("late finder");
  });

  it("a load that fails after the timeout is not reported twice", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const work = new Promise<string>((_resolve, reject) => (fail = reject));
    const outcome = withTimeout(work, 1000, vi.fn()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(((await outcome) as RetouchError).code).toBe("init-timeout");
    // No unhandled rejection: the late failure is swallowed.
    fail(new Error("wasm aborted"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
