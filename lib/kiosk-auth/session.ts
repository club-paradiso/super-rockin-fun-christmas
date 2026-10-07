import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Kiosk session cookie: `v1.<kioskId>.<issuedAt>.<expiresAt>.<hmac>`
 * (times in unix seconds, HMAC-SHA256 over everything before the last dot).
 *
 * Signed so it cannot be forged, but authority also requires the kiosk row to exist and not be
 * revoked (checked on every use), so a stolen cookie can be cut off without rotating secrets.
 */
export const KIOSK_COOKIE = "ftl_kiosk";

export interface KioskSessionClaims {
  kioskId: string;
  issuedAt: number;
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signKioskSession(secret: string, claims: KioskSessionClaims): string {
  const payload = `v1.${claims.kioskId}.${claims.issuedAt}.${claims.expiresAt}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyKioskSession(
  secret: string,
  value: string | undefined | null,
  nowSec: number,
): KioskSessionClaims | null {
  if (!value || value.length > 256) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [, kioskId, iat, exp, sig] = parts as [string, string, string, string, string];
  const expected = Buffer.from(mac(secret, parts.slice(0, 4).join(".")));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!UUID.test(kioskId)) return null;
  const issuedAt = Number(iat);
  const expiresAt = Number(exp);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return null;
  if (expiresAt <= nowSec || issuedAt > nowSec + 60) return null;
  return { kioskId, issuedAt, expiresAt };
}
