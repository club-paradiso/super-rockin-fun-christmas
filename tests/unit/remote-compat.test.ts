import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteCamera } from "@/lib/camera/remote-camera";
import { CameraError } from "@/lib/camera";
import { decodeJpeg, shortId } from "@/lib/remote-camera/media";
import { PhoneCamera, type PhoneDeps } from "@/lib/remote-camera/phone";
import { realTimers } from "@/lib/remote-camera/shutter";

/**
 * iPadOS 15 / Safari 15 safety net (an iPad mini 4 cannot run anything newer). Browser support is
 * only proven on a device; these tests catch the two ways it usually breaks: using an API that older
 * Safari lacks without a fallback, and calling an optional API unguarded.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");

/** Code that runs in the browser (booth or phone). Server-only files are excluded. */
const BROWSER_FILES = [
  "lib/camera/remote-camera.ts",
  "lib/remote-camera/phone.ts",
  "lib/remote-camera/shutter.ts",
  "lib/remote-camera/transfer.ts",
  "lib/remote-camera/crc32.ts",
  "lib/remote-camera/rtc-link.ts",
  "lib/remote-camera/media.ts",
  "lib/remote-camera/protocol.ts",
  "lib/remote-camera/signaling-client.ts",
  "components/camera/remote-camera-page.tsx",
];

/** API → first Safari that has it. Anything newer than 15.0 must not appear unguarded. */
const NEWER_THAN_SAFARI_15: Array<[RegExp, string]> = [
  [/\.at\(\s*-?\d/, "Array.prototype.at (Safari 15.4)"],
  [/structuredClone\(/, "structuredClone (Safari 15.4)"],
  [/Object\.hasOwn\(/, "Object.hasOwn (Safari 15.4)"],
  [/\.findLast(Index)?\(/, "findLast (Safari 15.4)"],
  [/randomUUID\(/, "crypto.randomUUID (Safari 15.4, secure contexts only)"],
  [/\.toSorted\(|\.toReversed\(|\.with\(/, "change-array-by-copy (Safari 16)"],
  [/Array\.fromAsync|Promise\.withResolvers|Set\.prototype\.union/, "Safari 17+"],
  [/new ImageCapture\(/, "ImageCapture (not in iOS Safari)"],
  [/requestVideoFrameCallback/, "requestVideoFrameCallback (Safari 15.4)"],
  [/RTCRtpScriptTransform|createEncodedStreams/, "WebRTC encoded transforms (Safari 15.4+)"],
  [/AbortSignal\.(timeout|any)\(/, "AbortSignal.timeout/any (Safari 16)"],
  [/\.replaceChildren\(|\.showPopover\(/, "newer DOM APIs"],
  [/import\.meta\.dirname/, "not browser code"],
];

describe("browser code avoids APIs newer than iPadOS 15 Safari", () => {
  for (const file of BROWSER_FILES) {
    it(file, () => {
      const source = readFileSync(path.join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const hits = NEWER_THAN_SAFARI_15.filter(([re]) => re.test(source)).map(([, why]) => why);
      expect(hits).toEqual([]);
    });
  }

  it("optional platform APIs are feature-detected before use", () => {
    const phonePage = readFileSync(
      path.join(ROOT, "components/camera/remote-camera-page.tsx"),
      "utf8",
    );
    expect(phonePage).toMatch(/wakeLock\?:/); // Safari before 16.4 has no Wake Lock
    expect(phonePage).toMatch(/if \(wl\)/);
    const media = readFileSync(path.join(ROOT, "lib/remote-camera/media.ts"), "utf8");
    expect(media).toMatch(/typeof createImageBitmap === "function"/);
    const phone = readFileSync(path.join(ROOT, "lib/remote-camera/phone.ts"), "utf8");
    expect(phone).toMatch(/getSettings\?\./);
  });
});

describe("fallbacks", () => {
  const originalImage = globalThis.Image;
  const originalBitmap = globalThis.createImageBitmap;
  const originalUrl = { c: URL.createObjectURL, r: URL.revokeObjectURL };
  afterEach(() => {
    globalThis.Image = originalImage;
    globalThis.createImageBitmap = originalBitmap;
    URL.createObjectURL = originalUrl.c;
    URL.revokeObjectURL = originalUrl.r;
  });

  function fakeImage() {
    class FakeImage {
      decoding = "";
      src = "";
      naturalWidth = 800;
      naturalHeight = 600;
      async decode() {}
    }
    globalThis.Image = FakeImage as unknown as typeof Image;
    const revoked: string[] = [];
    URL.createObjectURL = () => "blob:fake";
    URL.revokeObjectURL = (u) => void revoked.push(u);
    return revoked;
  }

  it("decodes through <img> when createImageBitmap is missing", async () => {
    // @ts-expect-error simulating iPadOS < 15
    globalThis.createImageBitmap = undefined;
    const revoked = fakeImage();
    const img = await decodeJpeg(new Blob([new Uint8Array(10)]));
    expect([img.width, img.height]).toEqual([800, 600]);
    img.release();
    expect(revoked).toEqual(["blob:fake"]);
  });

  it("decodes through <img> when createImageBitmap rejects a Blob (older WebKit)", async () => {
    globalThis.createImageBitmap = (() => Promise.reject(new Error("TypeError"))) as never;
    fakeImage();
    const img = await decodeJpeg(new Blob([new Uint8Array(10)]));
    expect(img.width).toBe(800);
  });

  it("prefers createImageBitmap and closes the bitmap", async () => {
    const close = vi.fn();
    globalThis.createImageBitmap = (async () => ({ width: 1600, height: 1200, close })) as never;
    const img = await decodeJpeg(new Blob([new Uint8Array(10)]));
    expect(img.width).toBe(1600);
    img.release();
    expect(close).toHaveBeenCalled();
  });

  it("makes ids without crypto (non-secure origin, old Safari)", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      const a = shortId("c");
      const b = shortId("c");
      expect(a).toMatch(/^c[0-9a-z]{24}$/);
      expect(a).not.toBe(b);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the booth says 'unsupported' (not a crash) in a browser without WebRTC", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const camera = new RemoteCamera({
      fetchImpl: async (url) =>
        url.includes("/status")
          ? json({ paired: true, online: true })
          : json({ messages: [], last: 0, iceServers: [] }),
      sleep: async () => {},
    });
    await expect(camera.start()).rejects.toMatchObject({ kind: "unsupported" });
    await expect(camera.start()).rejects.toBeInstanceOf(CameraError);
  });

  it("the phone page reports an unsupported browser instead of throwing", async () => {
    const deps: PhoneDeps = {
      mediaDevices: undefined,
      fetchImpl: async () => new Response("{}", { status: 200 }),
      createPeer: () => {
        throw new Error("no webrtc");
      },
      createCanvas: () => {
        throw new Error("unused");
      },
      timers: realTimers,
      isHidden: () => false,
      isSecure: () => true,
      sleep: async () => {},
      storage: { get: () => null, set: () => undefined },
    };
    const phone = new PhoneCamera(deps);
    const video = {
      muted: false,
      playsInline: false,
      srcObject: null,
      play: async () => {},
    } as unknown as HTMLVideoElement;
    await phone.start(video);
    expect(phone.getView()).toMatchObject({ state: "error", error: "unsupported_browser" });
    phone.stop();
  });
});
