import { describe, expect, it } from "vitest";
import { KIOSK_CONFIG } from "@/config/kiosk";
import {
  VIDEO_MIMES,
  baseVideoMime,
  hasVideoSignature,
  parseByteRange,
  videoExt,
} from "@/lib/video/format";
import { JPEG, MP4, WEBM } from "../helpers/images";

describe("session video formats (D72)", () => {
  it("accepts exactly MP4 and WebM, MP4 preferred", () => {
    expect([...VIDEO_MIMES]).toEqual(["video/mp4", "video/webm"]);
    expect(baseVideoMime("video/webm;codecs=vp9")).toBe("video/webm");
    expect(baseVideoMime("Video/MP4; codecs=avc1.42E01E")).toBe("video/mp4");
    for (const other of ["video/quicktime", "image/jpeg", "audio/webm", "", null, undefined])
      expect(baseVideoMime(other)).toBeNull();
    expect([videoExt("video/mp4"), videoExt("video/webm")]).toEqual(["mp4", "webm"]);
  });

  it("checks magic bytes against the declared type", () => {
    expect(hasVideoSignature(WEBM, "video/webm")).toBe(true);
    expect(hasVideoSignature(MP4, "video/mp4")).toBe(true);
    expect(hasVideoSignature(WEBM, "video/mp4")).toBe(false);
    expect(hasVideoSignature(MP4, "video/webm")).toBe(false);
    expect(hasVideoSignature(JPEG, "video/mp4")).toBe(false);
    expect(hasVideoSignature(new Uint8Array(), "video/webm")).toBe(false);
    expect(hasVideoSignature(WEBM, "video/quicktime")).toBe(false);
  });

  it("the size cap stays under the cloud's request body limit", () => {
    expect(KIOSK_CONFIG.videoMaxBytes).toBe(3_500_000);
    expect(KIOSK_CONFIG.videoMaxBytes).toBeLessThan(4.5 * 1024 * 1024);
    // A full-length reel at the configured bitrate must not fit: retakes are cut off by bytes.
    expect(KIOSK_CONFIG.videoSecondsPerShot).toBeLessThanOrEqual(KIOSK_CONFIG.countdownSeconds);
  });
});

describe("byte ranges", () => {
  it("no header, malformed or multi-range: the whole body", () => {
    for (const h of [null, "", "bytes=", "bytes=-", "items=0-1", "bytes=0-1,5-6", "bytes=a-b"])
      expect(parseByteRange(h, 100)).toEqual({ kind: "full" });
  });

  it("closed, open-ended and suffix ranges; end is inclusive and clamped", () => {
    expect(parseByteRange("bytes=0-1", 100)).toEqual({ kind: "partial", start: 0, end: 1 });
    expect(parseByteRange("bytes=10-", 100)).toEqual({ kind: "partial", start: 10, end: 99 });
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseByteRange("bytes=-20", 100)).toEqual({ kind: "partial", start: 80, end: 99 });
    expect(parseByteRange("bytes=-500", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
  });

  it("outside the body: unsatisfiable", () => {
    expect(parseByteRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=5-2", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
  });
});
