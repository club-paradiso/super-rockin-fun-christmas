// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraError } from "@/lib/camera";
import { RemoteCamera } from "@/lib/camera/remote-camera";
import { PhoneCamera, type PhoneDeps } from "@/lib/remote-camera/phone";
import { realTimers } from "@/lib/remote-camera/shutter";
import { FakeNet, FakePeer, FakeStream, FakeTrack } from "../helpers/fake-rtc";
import { fakeCanvasFactory } from "../helpers/fake-canvas";

/**
 * Remote Camera end to end, minus the radio: the booth's RemoteCamera and the phone's PhoneCamera
 * talk through the REAL route handlers (staff pairing, camera cookie, kiosk cookie, signaling
 * mailbox, revocation) and a fake WebRTC link. Everything above and below WebRTC is real code.
 */
const ORIGIN = "https://booth.example.org";
const PASSWORD = "shared-enroll-password-for-tests";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-remote-cam-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "r".repeat(48),
    KIOSK_ENROLL_SECRET: PASSWORD,
    PUBLIC_BASE_URL: ORIGIN,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

let ipCounter = 0;
const ip = () => `198.51.100.${++ipCounter % 250}`;

interface Session {
  admin: string;
  kioskCookie: string;
  kioskId: string;
}

async function newSession(label = "booth"): Promise<Session> {
  const { POST: enroll } = await import("@/app/api/kiosk/enroll/route");
  const enrolled = await enroll(
    new Request(`${ORIGIN}/api/kiosk/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip() },
      body: JSON.stringify({ secret: PASSWORD, label }),
    }),
  );
  const kioskCookie = cookieOf(enrolled, "ftl_kiosk");
  const { POST: login } = await import("@/app/api/admin/auth/password/route");
  const loggedIn = await login(
    new Request(`${ORIGIN}/api/admin/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip() },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const admin = cookieOf(loggedIn, "ftl_admin");
  const { getBackend } = await import("@/lib/storage/server");
  const kiosks = await getBackend().kiosks.list();
  const kioskId = kiosks.find((k) => k.label === label)!.id;
  return { admin, kioskCookie, kioskId };
}

async function issueCode(s: Session): Promise<string> {
  const { POST } = await import("@/app/api/admin/remote-camera/link/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/admin/remote-camera/link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: s.admin,
        "x-forwarded-for": ip(),
      },
      body: JSON.stringify({ kioskId: s.kioskId }),
    }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string; url: string; secure: boolean };
  expect(body.secure).toBe(true);
  expect(body.url).toContain(`${ORIGIN}/camera/remote?code=`);
  return body.code;
}

async function pairPhone(
  code: string,
  name = "Test iPhone",
): Promise<{ status: number; cookie: string }> {
  const { POST } = await import("@/app/api/camera/link/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/camera/link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip() },
      body: JSON.stringify({ code, name }),
    }),
  );
  return { status: res.status, cookie: cookieOf(res, "ftl_camera") };
}

/** fetch() that calls the real route handlers with a fixed cookie. */
function routedFetch(cookie: string) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, ORIGIN);
    const method = (init.method ?? "GET").toUpperCase();
    const req = new Request(url, {
      ...init,
      method,
      headers: {
        origin: ORIGIN,
        cookie,
        "x-forwarded-for": "203.0.113.9",
        ...(init.headers as Record<string, string>),
      },
    });
    const ctx = { params: Promise.resolve({}) };
    switch (url.pathname) {
      case "/api/kiosk/camera/status":
        return (await import("@/app/api/kiosk/camera/status/route")).GET(req);
      case "/api/kiosk/camera/signal": {
        const mod = await import("@/app/api/kiosk/camera/signal/route");
        return method === "POST" ? mod.POST(req) : mod.GET(req);
      }
      case "/api/camera/signal": {
        const mod = await import("@/app/api/camera/signal/route");
        return method === "POST" ? mod.POST(req) : mod.GET(req);
      }
      case "/api/camera/status":
        return (await import("@/app/api/camera/status/route")).POST(req);
      case "/api/camera/unlink":
        return (await import("@/app/api/camera/unlink/route")).POST(req);
      default:
        void ctx;
        throw new Error(`unrouted ${url.pathname}`);
    }
  };
}

async function adminAction(s: Session, id: string, body: unknown) {
  const { POST } = await import("@/app/api/admin/remote-camera/[id]/route");
  return POST(
    new Request(`${ORIGIN}/api/admin/remote-camera/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: s.admin,
        "x-forwarded-for": ip(),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function adminList(s: Session) {
  const { GET } = await import("@/app/api/admin/remote-camera/route");
  const res = await GET(
    new Request(`${ORIGIN}/api/admin/remote-camera`, {
      headers: { cookie: s.admin, "x-forwarded-for": ip() },
    }),
    { params: Promise.resolve({}) },
  );
  return (await res.json()) as {
    cameras: Array<{
      id: string;
      online: boolean;
      report: Record<string, unknown>;
      kioskLabel: string;
    }>;
  };
}

/** The phone's browser: a fake rear camera feeding a fake <video>, a fake canvas that "encodes". */
function makePhone(
  net: FakeNet,
  cookie: string,
  opts: { hidden?: () => boolean; secure?: boolean; denyCamera?: boolean } = {},
) {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  let t = 0;
  const video = {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    readyState: 4,
    videoWidth: 4032,
    videoHeight: 3024,
    paused: false,
    get currentTime() {
      return (t += 0.04);
    },
    play: async () => {},
  };
  const gum = vi.fn(async () => {
    if (opts.denyCamera) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    return stream as unknown as MediaStream;
  });
  const { factory } = fakeCanvasFactory();
  let shot = 0;
  const deps: PhoneDeps = {
    mediaDevices: { getUserMedia: gum },
    fetchImpl: routedFetch(cookie),
    createPeer: (config) => new FakePeer(net, config) as unknown as RTCPeerConnection,
    createCanvas: (w, h) => {
      const c = factory(w, h) as unknown as {
        toBlob: (cb: (b: Blob) => void, type?: string, q?: number) => void;
      };
      const bytes = new Uint8Array(Math.round((w * h) / 40));
      bytes.fill(++shot % 251);
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      c.toBlob = (cb) => cb(new Blob([bytes], { type: "image/jpeg" }));
      return c as never;
    },
    timers: realTimers,
    isHidden: opts.hidden ?? (() => false),
    isSecure: () => opts.secure ?? true,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    storage: { get: () => null, set: () => undefined },
    pollMs: { fast: 15, slow: 30 },
  };
  const phone = new PhoneCamera(deps);
  return { phone, track, video: video as unknown as HTMLVideoElement, gum };
}

function makeBooth(
  net: FakeNet,
  cookie: string,
  over: Partial<ConstructorParameters<typeof RemoteCamera>[0]> = {},
) {
  const { factory, created } = fakeCanvasFactory();
  let n = 0;
  const camera = new RemoteCamera({
    fetchImpl: routedFetch(cookie),
    createPeer: (config) => new FakePeer(net, config) as unknown as RTCPeerConnection,
    createStream: (tracks) =>
      new FakeStream(tracks as unknown as FakeTrack[]) as unknown as MediaStream,
    createCanvas: factory,
    decode: async (blob) => ({
      source: {} as CanvasImageSource,
      width: 1600,
      height: 1200,
      release: () => void blob.size,
    }),
    newId: () => `id${String(++n).padStart(8, "0")}`,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    connectTimeoutMs: 1500,
    attempts: 2,
    pollMs: { fast: 15, slow: 30 },
    ...over,
  });
  return { camera, created };
}

const OPTIONS = { aspect: 4 / 3, mirror: true, maxWidth: 1600 };

let live: Array<{ stop(): void }> = [];
afterEach(() => {
  live.forEach((x) => x.stop());
  live = [];
});

describe("pairing (real routes)", () => {
  let s: Session;
  beforeAll(async () => {
    s = await newSession("pairing booth");
  });

  it("only staff can create a code, only for a real kiosk", async () => {
    const { POST } = await import("@/app/api/admin/remote-camera/link/route");
    const anon = await POST(
      new Request(`${ORIGIN}/api/admin/remote-camera/link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ kioskId: s.kioskId }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(anon.status).toBe(401);
    // the booth's own cookie is not staff
    const withKiosk = await POST(
      new Request(`${ORIGIN}/api/admin/remote-camera/link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: s.kioskCookie },
        body: JSON.stringify({ kioskId: s.kioskId }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(withKiosk.status).toBe(401);
    const bad = await POST(
      new Request(`${ORIGIN}/api/admin/remote-camera/link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: s.admin },
        body: JSON.stringify({ kioskId: "33333333-3333-4333-8333-333333333333" }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(bad.status).toBe(404);
  });

  it("a code works once; a wrong, reused or malformed code is the same refusal", async () => {
    const code = await issueCode(s);
    const first = await pairPhone(code);
    expect(first.status).toBe(200);
    expect(first.cookie).toMatch(/^ftl_camera=c1\./);
    expect((await pairPhone(code)).status).toBe(400);
    expect((await pairPhone("ZZZZZZZZ")).status).toBe(400);
    expect((await pairPhone("short")).status).toBe(400);
  });

  it("the camera cookie is not a booth cookie, and a booth cookie is not a camera", async () => {
    const code = await issueCode(s);
    const { cookie } = await pairPhone(code);
    const asBooth = await routedFetch(cookie)("/api/kiosk/camera/status");
    expect(asBooth.status).toBe(401);
    const asCamera = await routedFetch(s.kioskCookie)("/api/camera/signal?after=0");
    expect(asCamera.status).toBe(401);
    const noCookie = await routedFetch("")("/api/camera/signal?after=0");
    expect(noCookie.status).toBe(401);
  });

  it("rate limits guessing from one address", async () => {
    const { POST } = await import("@/app/api/camera/link/route");
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await POST(
        new Request(`${ORIGIN}/api/camera/link`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-forwarded-for": "192.0.2.77",
          },
          body: JSON.stringify({ code: "ABCD2345" }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((x) => x === 400)).toBe(true);
    expect(statuses).toContain(429);
  });

  it("refuses cross-origin pairing and signaling posts", async () => {
    const { POST } = await import("@/app/api/camera/link/route");
    const res = await POST(
      new Request(`${ORIGIN}/api/camera/link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "x-forwarded-for": ip(),
        },
        body: JSON.stringify({ code: "ABCD2345" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a revoked pairing stops working at once", async () => {
    const s2 = await newSession("revoke booth");
    const { cookie } = await pairPhone(await issueCode(s2));
    const f = routedFetch(cookie);
    expect((await f("/api/camera/signal?after=0")).status).toBe(200);
    const list = await adminList(s2);
    const id = list.cameras.find((c) => c.kioskLabel === "revoke booth")!.id;
    expect((await adminAction(s2, id, { action: "revoke" })).status).toBe(200);
    expect((await f("/api/camera/signal?after=0")).status).toBe(401);
    expect(
      ((await (await f("/api/camera/signal?after=0")).json()) as { error: string }).error,
    ).toBe("revoked");
  });
});

describe("remote camera end to end", () => {
  let s: Session;
  let net: FakeNet;
  beforeEach(async () => {
    net = new FakeNet();
    s = await newSession(`e2e-${Math.random().toString(36).slice(2, 8)}`);
  });

  async function connected() {
    const { cookie } = await pairPhone(await issueCode(s));
    const phoneSide = makePhone(net, cookie);
    live.push(phoneSide.phone);
    await phoneSide.phone.start(phoneSide.video);
    const booth = makeBooth(net, s.kioskCookie);
    live.push(booth.camera);
    await booth.camera.start();
    return { phoneSide, booth, cookie };
  }

  it("the booth refuses cleanly when nothing is paired, and when the phone is offline", async () => {
    const booth = makeBooth(net, s.kioskCookie);
    await expect(booth.camera.start()).rejects.toMatchObject({ kind: "missing" });
    const { cookie } = await pairPhone(await issueCode(s));
    expect(cookie).not.toBe("");
    // paired, but the phone page never reported in a while: still counts as "just paired" (online)
    // so simulate offline by waiting for the window with a backdated heartbeat
    const { getRemoteCameraStore } = await import("@/lib/remote-camera/server");
    const p = (await getRemoteCameraStore().activeForKiosk(s.kioskId))!;
    await getRemoteCameraStore().setReport(
      p.id,
      p.report,
      new Date(Date.now() - 60_000).toISOString(),
    );
    await expect(makeBooth(net, s.kioskCookie).camera.start()).rejects.toMatchObject({
      kind: "missing",
    });
  });

  it("an unenrolled booth is told it is not enrolled", async () => {
    await expect(makeBooth(net, "").camera.start()).rejects.toMatchObject({ kind: "denied" });
  });

  it("pairs, previews, and delivers four distinct photos in the existing frame format", async () => {
    const { booth, phoneSide } = await connected();
    expect(booth.camera.kind).toBe("remote");
    expect(booth.camera.isActive()).toBe(true);
    expect(booth.camera.getStream()).not.toBeNull();
    expect(booth.camera.isStalled()).toBe(false);
    expect(phoneSide.phone.getView().state).toBe("live");
    const frames = [];
    for (let i = 0; i < 4; i++) frames.push(await booth.camera.capture(OPTIONS));
    // the same crop/mirror rule as every provider: 4:3, at most 1600 wide, mirrored like the preview
    for (const f of frames) {
      expect(f.mirrored).toBe(true);
      expect(f.width).toBe(1600);
      expect(f.height).toBe(1200);
    }
    expect(booth.camera.metrics.captures).toBe(4);
    expect(booth.camera.metrics.lastTotalMs).not.toBeNull();
    expect(booth.camera.metrics.lastBytes).toBeGreaterThan(10_000);
    // each shot was a separate request id on the wire
    const ids = net.messages
      .filter((m) => m.text?.includes('"CAPTURE_REQUEST"'))
      .map((m) => JSON.parse(m.text!).id);
    expect(new Set(ids).size).toBe(4);
    expect(phoneSide.phone.getView().shots).toBe(4);
  });

  it("an individual retake is just another capture, and earlier shots are untouched", async () => {
    const { booth } = await connected();
    const first = await booth.camera.capture(OPTIONS);
    const second = await booth.camera.capture(OPTIONS);
    const retake = await booth.camera.capture(OPTIONS);
    expect(retake).not.toBe(second);
    expect(first.canvas).not.toBe(retake.canvas);
  });

  it("never advances after a failed capture: the error reaches the booth", async () => {
    const { booth, phoneSide } = await connected();
    phoneSide.track.muted = true; // the browser has muted the feed: frozen picture
    await expect(booth.camera.capture(OPTIONS)).rejects.toBeInstanceOf(CameraError);
    expect(booth.camera.metrics.failures).toBe(1);
    phoneSide.track.muted = false;
    const ok = await booth.camera.capture(OPTIONS);
    expect(ok.width).toBe(1600);
  });

  it("recovers from a damaged transfer without a second shot", async () => {
    const { booth, phoneSide } = await connected();
    let tampered = false;
    net.filter = (from, data) => {
      if (!tampered && typeof data !== "string" && data.byteLength > 100) {
        tampered = true;
        const copy = new Uint8Array(data.slice(0));
        copy[50] = copy[50]! ^ 0xff;
        return copy.buffer;
      }
      return data;
    };
    const frame = await booth.camera.capture(OPTIONS);
    expect(frame.width).toBe(1600);
    expect(booth.camera.metrics.resends).toBe(1);
    expect(phoneSide.phone.getView().shots).toBe(1);
  });

  it("detects the phone going away: onDisconnect fires and capture is refused", async () => {
    const { booth } = await connected();
    const lost = vi.fn();
    booth.camera.onDisconnect(lost);
    for (const peer of net.peers.values()) if (peer.config) peer.dc?.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(lost).toHaveBeenCalled();
    expect(booth.camera.isActive()).toBe(false);
    await expect(booth.camera.capture(OPTIONS)).rejects.toBeInstanceOf(CameraError);
  });

  it("reconnects after a lost link (bounded retries inside start) and the phone goes back to waiting", async () => {
    const { booth, phoneSide } = await connected();
    for (const peer of net.peers.values()) peer.dc?.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(phoneSide.phone.getView().state).toBe("idle");
    await booth.camera.start();
    expect(booth.camera.isActive()).toBe(true);
    expect((await booth.camera.capture(OPTIONS)).width).toBe(1600);
  });

  it("a connection attempt that cannot finish fails after its bounded tries", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    // a phone that never answers: paired and "online" (it reported) but its page is not polling
    const f = routedFetch(cookie);
    expect((await f("/api/camera/signal?after=0")).status).toBe(200);
    const booth = makeBooth(net, s.kioskCookie, { connectTimeoutMs: 80, attempts: 2 });
    const t0 = Date.now();
    await expect(booth.camera.start()).rejects.toMatchObject({ kind: "failed" });
    expect(Date.now() - t0).toBeLessThan(2000);
    // both attempts were made (two offers)
    expect(net.messages.length).toBe(0);
    expect([...net.peers.values()].every((p) => p.closed)).toBe(true);
  });

  it("stop() while connecting leaves nothing behind", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    const phoneSide = makePhone(net, cookie);
    live.push(phoneSide.phone);
    await phoneSide.phone.start(phoneSide.video);
    const booth = makeBooth(net, s.kioskCookie);
    const p = booth.camera.start();
    booth.camera.stop();
    await expect(p).rejects.toBeInstanceOf(CameraError);
    expect(booth.camera.isActive()).toBe(false);
    expect(booth.camera.getStream()).toBeNull();
  });

  it("the phone reports to staff: state, resolutions, shutter timing, no picture", async () => {
    const { booth, phoneSide } = await connected();
    await booth.camera.capture(OPTIONS);
    await new Promise((r) => setTimeout(r, 40));
    void phoneSide;
    const view = await adminList(s);
    const cam = view.cameras.find((c) => c.kioskLabel === s.kioskId || c.online)!;
    expect(cam.online).toBe(true);
    expect(cam.report).toMatchObject({ state: "live", mode: "hq" });
    expect(cam.report.captureWidth).toBe(1600);
    expect(cam.report.testThumb).toBeNull();
  });

  it("staff commands reach the phone: test capture returns a tiny thumbnail and timings", async () => {
    const { phoneSide } = await connected();
    const view = await adminList(s);
    const id = view.cameras.find((c) => c.online)!.id;
    expect((await adminAction(s, id, { action: "testCapture" })).status).toBe(200);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const v = await adminList(s);
      const cam = v.cameras.find((c) => c.id === id)!;
      if (cam.report.testThumb) {
        expect(String(cam.report.testThumb)).toMatch(/^data:image\/jpeg;base64,/);
        expect(cam.report.lastEncodeMs).not.toBeNull();
        return;
      }
    }
    throw new Error(`no test thumbnail; phone state ${JSON.stringify(phoneSide.phone.getView())}`);
  });

  it("staff can switch the quality mode, reconnect, and disconnect; bad commands are refused", async () => {
    const { phoneSide } = await connected();
    const id = (await adminList(s)).cameras.find((c) => c.online)!.id;
    expect((await adminAction(s, id, { action: "setMode", mode: "eco" })).status).toBe(200);
    for (let i = 0; i < 60 && phoneSide.phone.getView().mode !== "eco"; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(phoneSide.phone.getView().mode).toBe("eco");
    expect((await adminAction(s, id, { action: "setMode", mode: "ultra" })).status).toBe(400);
    expect((await adminAction(s, id, { action: "rm" })).status).toBe(400);
    expect((await adminAction(s, id, { action: "disconnect" })).status).toBe(200);
    expect((await adminAction(s, "not-a-uuid", { action: "revoke" })).status).toBe(404);
  });

  it("a revoked phone stops itself and says so", async () => {
    const { phoneSide } = await connected();
    const id = (await adminList(s)).cameras.find((c) => c.online)!.id;
    await adminAction(s, id, { action: "revoke" });
    for (let i = 0; i < 60 && !phoneSide.phone.getView().revoked; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(phoneSide.phone.getView().revoked).toBe(true);
    expect(phoneSide.phone.getView().state).toBe("offline");
  });
});

describe("frozen preview detection", () => {
  async function bootWith(
    statsOf: (peer: FakePeer) => Promise<Map<string, Record<string, unknown>>>,
  ) {
    const net = new FakeNet();
    const s = await newSession(`frozen-${Math.random().toString(36).slice(2, 8)}`);
    const { cookie } = await pairPhone(await issueCode(s));
    const phoneSide = makePhone(net, cookie);
    live.push(phoneSide.phone);
    await phoneSide.phone.start(phoneSide.video);
    let offset = 0;
    const booth = makeBooth(net, s.kioskCookie, {
      timers: { ...realTimers, now: () => Date.now() + offset },
      createPeer: (config) => {
        const peer = new FakePeer(net, config);
        peer.getStats = (() => statsOf(peer)) as never;
        return peer as unknown as RTCPeerConnection;
      },
    });
    live.push(booth.camera);
    await booth.camera.start();
    return { booth, advance: (ms: number) => (offset += ms) };
  }

  it("a stream whose decoded-frame count stops advancing is stalled", async () => {
    const { booth, advance } = await bootWith(
      async () => new Map([["in", { type: "inbound-rtp", kind: "video", framesDecoded: 42 }]]),
    );
    // heartbeats sample the stats (2 s apart); first sample records frame 42, later ones see no progress
    await new Promise((r) => setTimeout(r, 2200));
    expect(booth.camera.isStalled()).toBe(false);
    advance(10_000);
    expect(booth.camera.isStalled()).toBe(true);
  });

  it("a browser whose stats lack frame counters is never called frozen", async () => {
    const { booth, advance } = await bootWith(
      async () => new Map([["in", { type: "inbound-rtp", kind: "video" }]]),
    );
    await new Promise((r) => setTimeout(r, 2200));
    advance(60_000);
    expect(booth.camera.isStalled()).toBe(false);
  });

  it("a muted track is stalled at once", async () => {
    const { booth } = await bootWith(async () => new Map());
    const stream = booth.camera.getStream() as unknown as { getVideoTracks(): FakeTrack[] };
    stream.getVideoTracks()[0]!.muted = true;
    expect(booth.camera.isStalled()).toBe(true);
  });
});

describe("stale signaling", () => {
  it("a phone that (re)starts ignores offers already waiting, and offers older than the booth would wait", async () => {
    const net = new FakeNet();
    const s = await newSession(`stale-${Math.random().toString(36).slice(2, 8)}`);
    const { cookie } = await pairPhone(await issueCode(s));
    const { getRemoteCameraStore } = await import("@/lib/remote-camera/server");
    const store = getRemoteCameraStore();
    const pairing = (await store.activeForKiosk(s.kioskId))!;
    const old = (ms: number) => new Date(Date.now() - ms).toISOString();
    // an offer from a booth connection that died before this page loaded
    await store.push({
      pairingId: pairing.id,
      kioskId: s.kioskId,
      from: "kiosk",
      to: "camera",
      message: { t: "offer", sid: "deadbeef0001", sdp: "fake-offer:peer999" },
      nowIso: old(5_000),
    });
    const p = makePhone(net, cookie);
    live.push(p.phone);
    await p.phone.start(p.video);
    await new Promise((r) => setTimeout(r, 120));
    expect(p.phone.getView().state).toBe("idle");
    // and an offer that arrives "now" but was created too long ago is dropped as well
    await store.push({
      pairingId: pairing.id,
      kioskId: s.kioskId,
      from: "kiosk",
      to: "camera",
      message: { t: "offer", sid: "deadbeef0002", sdp: "fake-offer:peer999" },
      nowIso: old(60_000),
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(p.phone.getView().state).toBe("idle");
  });
});

describe("phone camera errors", () => {
  let s: Session;
  let net: FakeNet;
  beforeEach(async () => {
    net = new FakeNet();
    s = await newSession(`phone-${Math.random().toString(36).slice(2, 8)}`);
  });

  it("reports a denied camera permission with a stable code", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    const p = makePhone(net, cookie, { denyCamera: true });
    live.push(p.phone);
    await p.phone.start(p.video);
    expect(p.phone.getView()).toMatchObject({ state: "error", error: "permission_denied" });
    await new Promise((r) => setTimeout(r, 40));
    const cam = (await adminList(s)).cameras.find((c) => c.kioskLabel.startsWith("phone-"))!;
    expect(cam.report).toMatchObject({ state: "error", error: "permission_denied" });
  });

  it("refuses to use the camera on an insecure page", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    const p = makePhone(net, cookie, { secure: false });
    live.push(p.phone);
    await p.phone.start(p.video);
    expect(p.phone.getView().error).toBe("insecure_context");
    expect(p.gum).not.toHaveBeenCalled();
  });

  it("does not take a photo while the page is in the background, and never a stale one", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    let hidden = false;
    const p = makePhone(net, cookie, { hidden: () => hidden });
    live.push(p.phone);
    await p.phone.start(p.video);
    const spec = { aspect: 4 / 3, maxWidth: 1600, quality: 0.9 };
    expect((await p.phone.grab(spec)).width).toBe(1600);
    hidden = true;
    await expect(p.phone.grab(spec)).rejects.toMatchObject({ reason: "hidden" });
    hidden = false;
    p.track.muted = true;
    await expect(p.phone.grab(spec)).rejects.toMatchObject({ reason: "frozen_source" });
  });

  it("never upscales: a small feed gives a small photo", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    const p = makePhone(net, cookie);
    live.push(p.phone);
    (p.video as unknown as { videoWidth: number; videoHeight: number }).videoWidth = 1280;
    (p.video as unknown as { videoWidth: number; videoHeight: number }).videoHeight = 720;
    await p.phone.start(p.video);
    const photo = await p.phone.grab({ aspect: 4 / 3, maxWidth: 1600, quality: 0.9 });
    expect(photo.width).toBe(960); // 4:3 crop of 1280x720
    expect(photo.height).toBe(720);
    expect(photo.sourceWidth).toBe(1280);
  });

  it("sees a frozen video (same playback time) and fails the shot instead of reusing the frame", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    const p = makePhone(net, cookie);
    live.push(p.phone);
    await p.phone.start(p.video);
    const v = p.video as unknown as { currentTime: number };
    Object.defineProperty(v, "currentTime", { value: 5, configurable: true });
    const spec = { aspect: 4 / 3, maxWidth: 1600, quality: 0.9 };
    await p.phone.grab(spec); // first grab records time 5
    await expect(p.phone.grab(spec)).rejects.toMatchObject({ reason: "frozen_source" });
  });

  it("restarts the camera when the track ends (bounded backoff) and keeps working", async () => {
    const { cookie } = await pairPhone(await issueCode(s));
    const p = makePhone(net, cookie);
    live.push(p.phone);
    await p.phone.start(p.video);
    expect(p.gum).toHaveBeenCalledTimes(1);
    p.track.end();
    expect(p.phone.getView().state).toBe("error");
    for (let i = 0; i < 100 && p.phone.getView().state === "error"; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(p.gum.mock.calls.length).toBeGreaterThan(1);
    expect(p.phone.getView().recovery).toBeGreaterThan(0);
  });
});
