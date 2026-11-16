import { describe, expect, it } from "vitest";
import { resolveCameraMode } from "@/lib/camera";
import {
  PAIRING_CODE_LENGTH,
  backoffMs,
  cleanCameraName,
  formatPairingCode,
  isCaptureId,
  isSid,
  normalizePairingCode,
  parseCtl,
  parseReport,
  parseSignal,
  EMPTY_REPORT,
} from "@/lib/remote-camera/protocol";
import {
  deriveCameraKey,
  signCameraSession,
  verifyCameraSession,
} from "@/lib/remote-camera/session";
import { hashPairingCode, newPairingCode } from "@/lib/remote-camera/pairing-code";
import { parseIceServers, DEFAULT_ICE_SERVERS } from "@/lib/remote-camera/ice";

describe("camera mode selection", () => {
  it("query wins over env; remote is only ever explicit; anything else is the webcam", () => {
    expect(resolveCameraMode("remote", undefined)).toBe("remote");
    expect(resolveCameraMode(undefined, "remote")).toBe("remote");
    expect(resolveCameraMode("mock", "remote")).toBe("mock");
    expect(resolveCameraMode("browser", "remote")).toBe("browser");
    expect(resolveCameraMode(undefined, undefined)).toBe("browser");
    expect(resolveCameraMode("REMOTE", undefined)).toBe("browser");
    expect(resolveCameraMode("iphone", undefined)).toBe("browser");
  });
});

describe("signaling messages", () => {
  const sid = "abcdef123456";
  it("accepts each message only from the side that may send it", () => {
    expect(parseSignal({ t: "offer", sid, sdp: "v=0" }, "kiosk")).not.toBeNull();
    expect(parseSignal({ t: "offer", sid, sdp: "v=0" }, "camera")).toBeNull();
    expect(parseSignal({ t: "answer", sid, sdp: "v=0" }, "camera")).not.toBeNull();
    expect(parseSignal({ t: "answer", sid, sdp: "v=0" }, "kiosk")).toBeNull();
    expect(parseSignal({ t: "cmd", cmd: { name: "reconnect" } }, "admin")).not.toBeNull();
    // a booth or a phone can never issue staff commands
    expect(parseSignal({ t: "cmd", cmd: { name: "reconnect" } }, "kiosk")).toBeNull();
    expect(parseSignal({ t: "cmd", cmd: { name: "reconnect" } }, "camera")).toBeNull();
    expect(parseSignal({ t: "ice", sid, candidate: null }, "admin")).toBeNull();
  });
  it("rejects malformed, oversized and unknown input", () => {
    expect(parseSignal(null, "kiosk")).toBeNull();
    expect(parseSignal({ t: "offer", sid: "x", sdp: "v=0" }, "kiosk")).toBeNull();
    expect(parseSignal({ t: "offer", sid, sdp: "x".repeat(30_000) }, "kiosk")).toBeNull();
    expect(parseSignal({ t: "rm -rf", sid }, "kiosk")).toBeNull();
    expect(parseSignal({ t: "cmd", cmd: { name: "setMode", mode: "ultra" } }, "admin")).toBeNull();
    expect(parseSignal({ t: "cmd", cmd: { name: "setMode", mode: "eco" } }, "admin")).toEqual({
      t: "cmd",
      cmd: { name: "setMode", mode: "eco" },
    });
    expect(
      parseSignal(
        { t: "ice", sid, candidate: { candidate: "x", sdpMid: "0", sdpMLineIndex: 99 } },
        "kiosk",
      ),
    ).toBeNull();
    expect(isSid("a b c d e f")).toBe(false);
  });
});

describe("shutter messages", () => {
  it("parses a request and clamps nothing silently: bad numbers are refused", () => {
    const ok = {
      t: "CAPTURE_REQUEST",
      id: "cap-123456",
      spec: { aspect: 4 / 3, maxWidth: 1600, quality: 0.9 },
    };
    expect(parseCtl(JSON.stringify(ok))).toMatchObject({ t: "CAPTURE_REQUEST", id: "cap-123456" });
    expect(parseCtl({ ...ok, spec: { aspect: 0, maxWidth: 1600, quality: 0.9 } })).toBeNull();
    expect(parseCtl({ ...ok, spec: { aspect: 1.3, maxWidth: 99999, quality: 0.9 } })).toBeNull();
    expect(parseCtl({ ...ok, id: "../x" })).toBeNull();
    expect(isCaptureId("short")).toBe(false);
  });
  it("refuses unknown types, non-JSON strings and huge strings", () => {
    expect(parseCtl("not json")).toBeNull();
    expect(parseCtl('{"t":"EVAL"}')).toBeNull();
    expect(parseCtl("x".repeat(5000))).toBeNull();
    expect(parseCtl({ t: "HEARTBEAT", n: 3 })).toEqual({ t: "HEARTBEAT", n: 3 });
    expect(parseCtl({ t: "HEARTBEAT", n: -1 })).toBeNull();
  });
});

describe("status report", () => {
  it("keeps numbers and codes, drops anything else", () => {
    const report = parseReport({
      ...EMPTY_REPORT,
      state: "live",
      captureWidth: 1600,
      captureHeight: 1200,
      error: "<script>",
      extra: "ignored",
    });
    expect(report).toMatchObject({ state: "live", captureWidth: 1600, error: null });
    expect(report).not.toHaveProperty("extra");
    expect(parseReport({ ...EMPTY_REPORT, state: "weird" })).toBeNull();
  });
  it("accepts only a small JPEG data URL as a test thumbnail", () => {
    const base = { ...EMPTY_REPORT, state: "idle" };
    expect(
      parseReport({ ...base, testThumb: "data:image/png;base64,AAA", testAt: "now" })?.testThumb,
    ).toBeNull();
    expect(
      parseReport({ ...base, testThumb: "data:image/jpeg;base64," + "A".repeat(20_000) })
        ?.testThumb,
    ).toBeNull();
    expect(
      parseReport({
        ...base,
        testThumb: "data:image/jpeg;base64,AAAA",
        testAt: "2026-11-16T00:00:00Z",
      })?.testThumb,
    ).toBe("data:image/jpeg;base64,AAAA");
  });
});

describe("pairing code", () => {
  it("is 8 characters from an unambiguous alphabet and normalises what a person types", () => {
    const code = newPairingCode();
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(normalizePairingCode(formatPairingCode(code).toLowerCase())).toBe(code);
    expect(normalizePairingCode(" abcd 2345 ")).toBe("ABCD2345");
    expect(normalizePairingCode("ABCD-234")).toBeNull();
    expect(normalizePairingCode("ABCD-23O5")).toBeNull(); // O is not in the alphabet
    expect(normalizePairingCode(12345678)).toBeNull();
  });
  it("is random and only its hash is meant to be stored", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newPairingCode()));
    expect(codes.size).toBe(200);
    expect(hashPairingCode("ABCD2345")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPairingCode("ABCD2345")).not.toContain("ABCD");
  });
  it("cleans a camera name typed on a phone", () => {
    expect(cleanCameraName("  <b>Hall</b>\n")).toBe("bHall/b");
    expect(cleanCameraName("")).toBe("iPhone 카메라");
    expect(cleanCameraName(7)).toBe("iPhone 카메라");
    expect(cleanCameraName("x".repeat(100))).toHaveLength(40);
  });
});

describe("camera session cookie", () => {
  const key = deriveCameraKey("s".repeat(48), "enroll-pass");
  const ids = {
    pairingId: "11111111-1111-4111-8111-111111111111",
    kioskId: "22222222-2222-4222-8222-222222222222",
  };
  const now = 1_800_000_000;
  it("verifies before expiry and only with the same secrets", () => {
    const value = signCameraSession(key, { ...ids, expiresAt: now + 60 });
    expect(verifyCameraSession(key, value, now)).toMatchObject(ids);
    expect(verifyCameraSession(key, value, now + 61)).toBeNull();
    expect(
      verifyCameraSession(deriveCameraKey("t".repeat(48), "enroll-pass"), value, now),
    ).toBeNull();
    expect(verifyCameraSession(deriveCameraKey("s".repeat(48), "other"), value, now)).toBeNull();
    expect(verifyCameraSession(key, value.slice(0, -2) + "xx", now)).toBeNull();
    expect(verifyCameraSession(key, "garbage", now)).toBeNull();
  });
});

describe("ICE servers", () => {
  it("defaults to free STUN and never throws on a bad setting", () => {
    expect(parseIceServers(undefined)).toEqual({ servers: DEFAULT_ICE_SERVERS, problem: null });
    const bad = parseIceServers("{oops");
    expect(bad.servers).toEqual(DEFAULT_ICE_SERVERS);
    expect(bad.problem).toMatch(/REMOTE_CAMERA_ICE_SERVERS/);
  });
  it("takes a TURN fallback only with credentials and sane URLs", () => {
    const ok = parseIceServers(
      JSON.stringify([
        { urls: "turn:turn.example.org:3478?transport=udp", username: "u", credential: "p" },
      ]),
    );
    expect(ok.problem).toBeNull();
    expect(ok.servers[0]!.urls).toEqual(["turn:turn.example.org:3478?transport=udp"]);
    expect(parseIceServers(JSON.stringify([{ urls: "turn:x.org" }])).problem).not.toBeNull();
    expect(parseIceServers(JSON.stringify([{ urls: "http://evil" }])).problem).not.toBeNull();
  });
});

describe("backoff", () => {
  it("doubles and caps", () => {
    expect([0, 1, 2, 3, 10].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 15000]);
  });
});
