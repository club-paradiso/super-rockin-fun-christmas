import "server-only";
import { randomBytes } from "node:crypto";
import { MOBILE_UPLOAD_CONFIG } from "@/config/mobile";
import { getServerConfig } from "@/lib/server/env";
import { deriveUploadKey, issueUploadToken, verifyUploadToken } from "./token";

/**
 * The upload MAC key. Derived from KIOSK_SESSION_SECRET with a separate label (so an upload token
 * can never be a kiosk cookie). Development without kiosk auth gets a per-process random key:
 * its QR codes stop working when the dev server restarts, which is fine there.
 */
export function uploadKey(): Buffer {
  const config = getServerConfig();
  if (config.kioskAuth.mode === "required") return deriveUploadKey(config.kioskAuth.sessionSecret);
  const g = globalThis as { __ftlDevUploadKey?: Buffer };
  return (g.__ftlDevUploadKey ??= randomBytes(32));
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A new QR for this server's phone page. Writes nothing. */
export function mintUploadSession(origin: string, kioskId: string | null) {
  const { token, claims } = issueUploadToken(
    uploadKey(),
    kioskId,
    MOBILE_UPLOAD_CONFIG.tokenTtlMinutes * 60,
    nowSec(),
  );
  return {
    sessionId: claims.sessionId,
    url: mobileUrl(origin, token),
    expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
  };
}

export function readUploadToken(token: string | null | undefined) {
  return verifyUploadToken(uploadKey(), token, nowSec());
}

export function mobileUrl(origin: string, token: string): string {
  return new URL(`/m/${encodeURIComponent(token)}`, origin).toString();
}
