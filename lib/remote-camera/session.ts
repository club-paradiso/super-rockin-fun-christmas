import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Camera session cookie: `c1.<pairingId>.<kioskId>.<expiresAt>.<mac>`. Its MAC key is derived with
 * its own label from KIOSK_SESSION_SECRET and KIOSK_ENROLL_SECRET, so it can never stand in for a
 * kiosk or staff cookie, and none of those can stand in for it. A valid signature is not enough:
 * the server also checks that the pairing is still active (revocation).
 */
export const CAMERA_COOKIE = "ftl_camera";

export interface CameraClaims {
  pairingId: string;
  kioskId: string;
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deriveCameraKey(sessionSecret: string, enrollSecret: string | null): Buffer {
  return createHmac("sha256", `${sessionSecret}\u0000${enrollSecret ?? ""}`)
    .update("ftl-remote-camera-v1")
    .digest();
}

const mac = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(payload).digest("base64url");

export function signCameraSession(key: Buffer, claims: CameraClaims): string {
  const payload = `c1.${claims.pairingId}.${claims.kioskId}.${claims.expiresAt}`;
  return `${payload}.${mac(key, payload)}`;
}

export function verifyCameraSession(
  key: Buffer,
  value: string | null | undefined,
  nowSec: number,
): CameraClaims | null {
  if (!value || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "c1") return null;
  const [, pairingId, kioskId, exp, sig] = parts as [string, string, string, string, string];
  const expected = Buffer.from(mac(key, parts.slice(0, 4).join(".")));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!UUID.test(pairingId) || !UUID.test(kioskId)) return null;
  const expiresAt = Number(exp);
  if (!Number.isInteger(expiresAt) || expiresAt <= nowSec) return null;
  return { pairingId, kioskId, expiresAt };
}
