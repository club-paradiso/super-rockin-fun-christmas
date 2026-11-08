import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Mobile upload QR token (D66): `u1.<sessionId>.<expiresAt>.<kioskId|->.<mac>`.
 *
 * Stateless and signed, so issuing a QR writes nothing: the server only stores something once a
 * photo actually arrives. The session id (a random UUID) becomes the photo's session id, which is
 * unique in storage — that is what makes a QR good for exactly one photo and makes a retried
 * upload idempotent. The token is only ever in the QR and the phone's address bar; it is never
 * stored or logged (logs carry the session id).
 *
 * `kioskId` is the booth that showed the QR (cloud-only deployments), or "-" when a hub asked
 * the cloud for it: the cloud does not know the hub's kiosks.
 */
export interface UploadClaims {
  sessionId: string;
  /** Unix seconds. */
  expiresAt: number;
  kioskId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LEN = 160;

/** The upload MAC key is derived with its own label, so it can never stand in for a kiosk cookie. */
export function deriveUploadKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("ftl-mobile-upload-v1").digest();
}

function mac(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signUploadToken(key: Buffer, claims: UploadClaims): string {
  const payload = `u1.${claims.sessionId}.${claims.expiresAt}.${claims.kioskId ?? "-"}`;
  return `${payload}.${mac(key, payload)}`;
}

export function issueUploadToken(
  key: Buffer,
  kioskId: string | null,
  ttlSeconds: number,
  nowSec: number,
): { token: string; claims: UploadClaims } {
  const claims = { sessionId: randomUUID(), expiresAt: nowSec + ttlSeconds, kioskId };
  return { token: signUploadToken(key, claims), claims };
}

export type VerifyResult =
  { ok: true; claims: UploadClaims } | { ok: false; reason: "malformed" | "expired" };

/**
 * Signature first, then expiry. A forged or truncated token is "malformed"; callers show the same
 * page for every failure so nothing about a token leaks.
 */
export function verifyUploadToken(
  key: Buffer,
  token: string | null | undefined,
  nowSec: number,
): VerifyResult {
  if (!token || token.length > MAX_LEN) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "u1") return { ok: false, reason: "malformed" };
  const [, sessionId, exp, kiosk, sig] = parts as [string, string, string, string, string];
  const expected = Buffer.from(mac(key, parts.slice(0, 4).join(".")));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: "malformed" };
  if (!UUID.test(sessionId) || (kiosk !== "-" && !UUID.test(kiosk)))
    return { ok: false, reason: "malformed" };
  const expiresAt = Number(exp);
  if (!Number.isInteger(expiresAt)) return { ok: false, reason: "malformed" };
  if (expiresAt <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true, claims: { sessionId, expiresAt, kioskId: kiosk === "-" ? null : kiosk } };
}
