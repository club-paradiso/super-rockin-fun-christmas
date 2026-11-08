// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deriveUploadKey,
  issueUploadToken,
  signUploadToken,
  verifyUploadToken,
} from "@/lib/mobile/token";
import { signKioskSession, verifyKioskSession } from "@/lib/kiosk-auth/session";

const SECRET = "s".repeat(48);
const KEY = deriveUploadKey(SECRET);
const KIOSK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = 1_800_000_000;

describe("phone upload QR token (D66)", () => {
  it("round-trips session, expiry and the issuing booth", () => {
    const { token, claims } = issueUploadToken(KEY, KIOSK, 900, NOW);
    expect(claims.expiresAt).toBe(NOW + 900);
    expect(verifyUploadToken(KEY, token, NOW + 899)).toEqual({ ok: true, claims });
    expect(token.length).toBeLessThan(160);
  });

  it("a hub-issued token carries no booth", () => {
    const { token } = issueUploadToken(KEY, null, 900, NOW);
    expect(token.split(".")[3]).toBe("-");
    const v = verifyUploadToken(KEY, token, NOW);
    expect(v.ok && v.claims.kioskId).toBeNull();
  });

  it("every QR is a different, random session", () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => issueUploadToken(KEY, null, 900, NOW).claims.sessionId),
    );
    expect(ids.size).toBe(200);
  });

  it("expires exactly at its time", () => {
    const { token } = issueUploadToken(KEY, KIOSK, 900, NOW);
    expect(verifyUploadToken(KEY, token, NOW + 900)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses forged, edited, truncated and foreign tokens", () => {
    const { token, claims } = issueUploadToken(KEY, KIOSK, 900, NOW);
    const parts = token.split(".");
    const longer = [...parts];
    longer[2] = String(NOW + 999_999);
    const bad = [
      longer.join("."),
      token.slice(0, -2),
      `${token}x`,
      "",
      "u1.x.y.z.w",
      token.replace("u1.", "u2."),
      signUploadToken(deriveUploadKey("t".repeat(48)), claims),
      "a".repeat(500),
    ];
    for (const t of bad)
      expect(verifyUploadToken(KEY, t, NOW).ok, `should refuse ${t.slice(0, 30)}`).toBe(false);
    expect(verifyUploadToken(KEY, null, NOW).ok).toBe(false);
  });

  it("can never stand in for a kiosk cookie, nor the other way round", () => {
    const cookie = signKioskSession(SECRET, {
      kioskId: KIOSK,
      issuedAt: NOW,
      expiresAt: NOW + 1000,
    });
    expect(verifyUploadToken(KEY, cookie, NOW).ok).toBe(false);
    const { token } = issueUploadToken(KEY, KIOSK, 900, NOW);
    expect(verifyKioskSession(SECRET, token, NOW)).toBeNull();
  });
});
