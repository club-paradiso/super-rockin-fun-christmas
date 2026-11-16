import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureSpec, CtlMessage } from "@/lib/remote-camera/protocol";
import {
  GrabError,
  ShutterClient,
  ShutterError,
  ShutterHost,
  type DuplexLink,
  type GrabbedPhoto,
} from "@/lib/remote-camera/shutter";
import { crc32 } from "@/lib/remote-camera/crc32";
import { readChunk, splitIntoChunks } from "@/lib/remote-camera/transfer";

const SPEC: CaptureSpec = { aspect: 4 / 3, maxWidth: 1600, quality: 0.9 };

function jpegLike(seed: number, size = 60_000): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 13 + seed) & 0xff;
  return out;
}

/**
 * Two ends of an ordered, reliable channel in memory. Delivery is asynchronous like the real
 * thing; `tamper` can damage the next binary chunk, `drop` can lose messages.
 */
function pair() {
  const state = {
    open: true,
    toHost: [] as Array<CtlMessage | Uint8Array>,
    tamper: null as null | ((c: Uint8Array) => Uint8Array),
    dropRequests: 0,
    hostSeen: [] as CtlMessage[],
    clientSeen: [] as CtlMessage[],
  };
  let host!: ShutterHost;
  let client!: ShutterClient;
  const deliver = (fn: () => void) => queueMicrotask(fn);
  const hostLink: DuplexLink = {
    isOpen: () => state.open,
    sendCtl: (m) => {
      state.clientSeen.push(m);
      deliver(() => client.handle(m));
    },
    sendBinary: async (tx, data) => {
      for (let chunk of splitIntoChunks(tx, data)) {
        if (state.tamper) {
          chunk = state.tamper(chunk);
          state.tamper = null;
        }
        const c = chunk;
        deliver(() => client.handleBinary(c));
      }
    },
  };
  const clientLink: DuplexLink = {
    isOpen: () => state.open,
    sendCtl: (m) => {
      state.hostSeen.push(m);
      if (m.t === "CAPTURE_REQUEST" && state.dropRequests > 0) {
        state.dropRequests--;
        return;
      }
      deliver(() => host.handle(m));
    },
    sendBinary: async () => {},
  };
  return {
    state,
    link: { hostLink, clientLink },
    bind(h: ShutterHost, c: ShutterClient) {
      host = h;
      client = c;
    },
  };
}

function setup(
  opts: {
    grab?: (spec: CaptureSpec) => Promise<GrabbedPhoto>;
    timeouts?: { started: number; total: number };
  } = {},
) {
  const net = pair();
  let n = 0;
  const shots: Uint8Array[] = [];
  const grab =
    opts.grab ??
    (async (spec: CaptureSpec): Promise<GrabbedPhoto> => {
      const bytes = jpegLike(++n);
      shots.push(bytes);
      return {
        bytes,
        width: Math.min(1600, spec.maxWidth),
        height: 1200,
        sourceWidth: 4032,
        sourceHeight: 3024,
        encodeMs: 40,
      };
    });
  const grabSpy = vi.fn(grab);
  const host = new ShutterHost(net.link.hostLink, grabSpy);
  let idn = 0;
  const client = new ShutterClient(
    net.link.clientLink,
    () => `cap-${String(++idn).padStart(6, "0")}`,
    undefined,
    opts.timeouts ?? { started: 500, total: 2000 },
  );
  net.bind(host, client);
  return { net, host, client, grabSpy, shots };
}

afterEach(() => vi.useRealTimers());

describe("remote shutter", () => {
  it("one request, one photo, verified and acknowledged", async () => {
    const { client, net, shots, host } = setup();
    const result = await client.capture(SPEC);
    expect(Array.from(result.data)).toEqual(Array.from(shots[0]!));
    expect(result.id).toBe("cap-000001");
    expect(result.resends).toBe(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    await Promise.resolve();
    expect(net.state.hostSeen.at(-1)).toMatchObject({ t: "CAPTURE_ACK", ok: true });
    expect(host.stats.shots).toBe(1);
  });

  it("four shots in a row are four different photos, each with its own id", async () => {
    const { client } = setup();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await client.capture(SPEC));
    expect(new Set(results.map((r) => r.id)).size).toBe(4);
    expect(new Set(results.map((r) => r.data[5])).size).toBeGreaterThan(1);
    const hashes = results.map((r) => Array.from(r.data.slice(0, 64)).join(","));
    expect(new Set(hashes).size).toBe(4);
  });

  it("refuses a second capture while one is in flight", async () => {
    const { client } = setup();
    const first = client.capture(SPEC);
    await expect(client.capture(SPEC)).rejects.toMatchObject({ kind: "busy" });
    await first;
  });

  it("a duplicate request never shoots twice (the phone answers once)", async () => {
    const { host, net, grabSpy } = setup();
    const req: CtlMessage = { t: "CAPTURE_REQUEST", id: "dup-000001", spec: SPEC };
    host.handle(req);
    host.handle(req);
    host.handle(req);
    await new Promise((r) => setTimeout(r, 20));
    expect(grabSpy).toHaveBeenCalledTimes(1);
    expect(host.stats.duplicates).toBe(2);
    expect(net.state.clientSeen.filter((m) => m.t === "CAPTURE_STARTED")).toHaveLength(1);
  });

  it("a request for the same id after the booth acknowledged is ignored, not re-shot", async () => {
    const { host, client, grabSpy } = setup();
    const r = await client.capture(SPEC);
    await new Promise((x) => setTimeout(x, 5));
    host.handle({ t: "CAPTURE_REQUEST", id: r.id, spec: SPEC, resend: true });
    await new Promise((x) => setTimeout(x, 20));
    expect(grabSpy).toHaveBeenCalledTimes(1);
  });

  it("a damaged chunk is repaired by asking for the same picture again, without a second shot", async () => {
    const { client, net, grabSpy, shots } = setup();
    net.state.tamper = (c) => {
      const copy = c.slice();
      copy[40] = copy[40]! ^ 0xff;
      return copy;
    };
    const result = await client.capture(SPEC);
    expect(result.resends).toBe(1);
    expect(grabSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(result.data)).toEqual(Array.from(shots[0]!));
  });

  it("gives up after bounded resends when the link keeps damaging the photo", async () => {
    const { client, net } = setup();
    const original = net.link.hostLink.sendBinary;
    net.link.hostLink.sendBinary = async (tx, data) => {
      net.state.tamper = (c) => {
        const copy = c.slice();
        copy[40] = copy[40]! ^ 0xff;
        return copy;
      };
      return original(tx, data);
    };
    await expect(client.capture(SPEC)).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("fails with a reason when the phone cannot shoot, and the next attempt is a fresh capture", async () => {
    let calls = 0;
    const { client } = setup({
      grab: async () => {
        if (++calls === 1) throw new GrabError("frozen_source");
        return {
          bytes: jpegLike(9),
          width: 1600,
          height: 1200,
          sourceWidth: 4032,
          sourceHeight: 3024,
          encodeMs: 30,
        };
      },
    });
    await expect(client.capture(SPEC)).rejects.toMatchObject({ kind: "frozen_source" });
    const ok = await client.capture(SPEC);
    expect(ok.id).toBe("cap-000002");
  });

  it("times out when the phone never answers, and a late answer is never used", async () => {
    const { client, net, host } = setup({ timeouts: { started: 30, total: 80 } });
    net.state.dropRequests = 1;
    await expect(client.capture(SPEC)).rejects.toMatchObject({ kind: "no_response" });
    // the late result of the lost request arrives after the next capture has begun
    const next = client.capture(SPEC);
    const stale = jpegLike(77, 500);
    client.handle({
      t: "CAPTURE_RESULT",
      id: "cap-000001",
      tx: 9,
      bytes: 500,
      chunks: 1,
      crc: crc32(stale),
      width: 1,
      height: 1,
      sourceWidth: 1,
      sourceHeight: 1,
      encodeMs: 1,
    });
    for (const c of splitIntoChunks(9, stale)) client.handleBinary(c);
    const result = await next;
    expect(result.id).toBe("cap-000002");
    expect(Array.from(result.data)).not.toEqual(Array.from(stale));
    expect(host.stats.shots).toBe(1);
  });

  it("times out a slow transfer (started, but the photo never completes)", async () => {
    const { client, net } = setup({ timeouts: { started: 200, total: 60 } });
    net.link.hostLink.sendBinary = async () => {};
    await expect(client.capture(SPEC)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("a result that answers a different id is not used", async () => {
    const { client, net } = setup({ timeouts: { started: 200, total: 80 } });
    net.link.hostLink.sendCtl = () => {};
    const p = client.capture(SPEC);
    client.handle({ t: "CAPTURE_STARTED", id: "cap-000001" });
    client.handle({
      t: "CAPTURE_RESULT",
      id: "other-id-1",
      tx: 1,
      bytes: 10,
      chunks: 1,
      crc: 0,
      width: 1,
      height: 1,
      sourceWidth: 1,
      sourceHeight: 1,
      encodeMs: 1,
    });
    const data = jpegLike(1, 10);
    for (const c of splitIntoChunks(1, data)) client.handleBinary(c);
    await expect(p).rejects.toMatchObject({ kind: "timeout" });
  });

  it("a lost link rejects the capture in flight", async () => {
    const { client, net } = setup({ timeouts: { started: 500, total: 1000 } });
    net.state.dropRequests = 1;
    const p = client.capture(SPEC);
    client.closed();
    await expect(p).rejects.toBeInstanceOf(ShutterError);
    await expect(p).rejects.toMatchObject({ kind: "disconnected" });
    net.state.open = false;
    await expect(client.capture(SPEC)).rejects.toMatchObject({ kind: "disconnected" });
  });

  it("the phone refuses a second capture while one is still being taken", async () => {
    let release!: () => void;
    const { host, net } = setup({
      grab: () =>
        new Promise<GrabbedPhoto>((resolve) => {
          release = () =>
            resolve({
              bytes: jpegLike(1, 100),
              width: 10,
              height: 10,
              sourceWidth: 10,
              sourceHeight: 10,
              encodeMs: 1,
            });
        }),
    });
    host.handle({ t: "CAPTURE_REQUEST", id: "first-00001", spec: SPEC });
    host.handle({ t: "CAPTURE_REQUEST", id: "second-0001", spec: SPEC });
    await new Promise((r) => setTimeout(r, 5));
    expect(net.state.clientSeen).toContainEqual({
      t: "CAPTURE_FAILED",
      id: "second-0001",
      reason: "busy",
    });
    release();
  });

  it("drops the picture from memory once acknowledged, and old results after the cache time", async () => {
    vi.useFakeTimers();
    let now = 0;
    const net = pair();
    const timers = {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as never),
    };
    const grab = vi.fn(async () => ({
      bytes: jpegLike(3, 500),
      width: 10,
      height: 10,
      sourceWidth: 10,
      sourceHeight: 10,
      encodeMs: 1,
    }));
    const host = new ShutterHost(net.link.hostLink, grab, timers, 1000);
    const client = new ShutterClient(net.link.clientLink, () => "cache-00001", timers, {
      started: 500,
      total: 2000,
    });
    net.bind(host, client);
    const p = client.capture(SPEC);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    // after the ack the bytes are gone: a resend request cannot produce them (and does not re-shoot)
    host.handle({ t: "CAPTURE_REQUEST", id: "cache-00001", spec: SPEC, resend: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(grab).toHaveBeenCalledTimes(1);
    now += 2000;
    host.handle({ t: "CAPTURE_REQUEST", id: "cache-00001", spec: SPEC });
    await vi.advanceTimersByTimeAsync(10);
    expect(grab).toHaveBeenCalledTimes(2); // expired entry: a genuinely new request
  });

  it("chunk headers are readable by the receiver (sanity for the wire format)", () => {
    const [c] = [...splitIntoChunks(7, jpegLike(1, 10))];
    expect(readChunk(c!)).toMatchObject({ tx: 7, index: 0, total: 1 });
  });

  it("four-shot sessions survive a lossy link (seeded, 0.5 % of chunks damaged, 500 KB photos)", async () => {
    let seed = 20261116;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const sessions = 40;
    let completed = 0;
    let resends = 0;
    let failedShots = 0;
    for (let s = 0; s < sessions; s++) {
      const net = pair();
      const host = new ShutterHost(net.link.hostLink, async () => ({
        bytes: jpegLike(s + 1, 500_000),
        width: 1600,
        height: 1200,
        sourceWidth: 4032,
        sourceHeight: 3024,
        encodeMs: 40,
      }));
      let idn = 0;
      const client = new ShutterClient(
        net.link.clientLink,
        () => `lossy-${s}-${String(++idn).padStart(4, "0")}`,
        undefined,
        { started: 500, total: 4000 },
      );
      net.bind(host, client);
      // damage chunks at delivery time
      const origHandle = client.handleBinary.bind(client);
      client.handleBinary = (buf) => {
        const copy = new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).slice();
        if (rand() < 0.005) copy[20 + Math.floor(rand() * 100)] = copy[20]! ^ 0xff;
        origHandle(copy);
      };
      let ok = true;
      for (let shot = 0; shot < 4; shot++) {
        try {
          const r = await client.capture(SPEC);
          resends += r.resends;
        } catch {
          ok = false;
          failedShots++;
          // the booth's own retry: one more fresh capture, as the state machine does
          try {
            const r = await client.capture(SPEC);
            resends += r.resends;
            ok = true;
          } catch {
            ok = false;
            break;
          }
        }
      }
      if (ok) completed++;
    }
    console.log(
      `[remote-shutter simulated] sessions=${sessions} completed=${completed} resends=${resends} failedShots=${failedShots}`,
    );
    expect(completed).toBeGreaterThanOrEqual(39);
  }, 60_000);
});
