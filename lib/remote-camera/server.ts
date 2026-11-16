import "server-only";
import { randomUUID } from "node:crypto";
import { readCookie } from "@/lib/kiosk-auth/server";
import { getServerConfig, secureCookies } from "@/lib/server/env";
import { jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { RateLimiter } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/server/request";
import { createServiceClient } from "@/lib/storage/supabase-backend";
import { parseIceServers, type IceConfig } from "./ice";
import { hashPairingCode, newPairingCode } from "./pairing-code";
import { TIMING, formatPairingCode } from "./protocol";
import { CAMERA_COOKIE, deriveCameraKey, signCameraSession, verifyCameraSession } from "./session";
import { SupabaseRemoteCameraStore } from "./supabase-store";
import { MemoryRemoteCameraStore, type Pairing, type RemoteCameraStore } from "./store";

const nowSec = () => Math.floor(Date.now() / 1000);

/** REMOTE_CAMERA_DISABLED=1 is the rollback switch: every Remote Camera route answers 404. */
export function remoteCameraDisabled(): boolean {
  return process.env.REMOTE_CAMERA_DISABLED === "1";
}

/**
 * The store lives on globalThis: Next.js bundles every route separately, and a per-module Map
 * would give each route its own empty mailbox (the same reason as the PIN limiters).
 */
export function getRemoteCameraStore(): RemoteCameraStore {
  const g = globalThis as { __ftlRemoteCamera?: RemoteCameraStore };
  if (g.__ftlRemoteCamera) return g.__ftlRemoteCamera;
  const config = getServerConfig();
  g.__ftlRemoteCamera =
    config.store === "supabase" && config.supabase
      ? new SupabaseRemoteCameraStore(createServiceClient(config.supabase))
      : new MemoryRemoteCameraStore();
  return g.__ftlRemoteCamera;
}

/** For tests only. */
export function resetRemoteCameraForTests(store?: RemoteCameraStore) {
  (globalThis as { __ftlRemoteCamera?: RemoteCameraStore }).__ftlRemoteCamera = store;
}

export function getIceConfig(): IceConfig {
  return parseIceServers(process.env.REMOTE_CAMERA_ICE_SERVERS);
}

function cameraKey(): Buffer | null {
  const config = getServerConfig();
  if (config.kioskAuth.mode !== "required") {
    // Development with KIOSK_AUTH_DISABLED=1: a fixed key, never reachable in production.
    return deriveCameraKey("development-only-camera-key-not-a-secret", null);
  }
  return deriveCameraKey(config.kioskAuth.sessionSecret, config.kioskAuth.enrollSecret);
}

export interface IssuedPairing {
  code: string;
  display: string;
  expiresAt: string;
}

/** Staff: a single-use code for one kiosk. Replaces that kiosk's unused code. */
export async function issuePairingCode(kioskId: string, staffId: string): Promise<IssuedPairing> {
  const code = newPairingCode();
  const now = Date.now();
  const expiresAt = new Date(now + TIMING.pairingCodeTtlMs).toISOString();
  await getRemoteCameraStore().issueCode({
    kioskId,
    codeHash: hashPairingCode(code),
    staffId,
    nowIso: new Date(now).toISOString(),
    expiresAtIso: expiresAt,
  });
  logEvent("camera_pair_code_issued", { kioskId, staffId });
  return { code, display: formatPairingCode(code), expiresAt };
}

export async function consumePairingCode(
  code: string,
  name: string,
): Promise<{ pairing: Pairing; cookieValue: string } | null> {
  const key = cameraKey();
  if (!key) return null;
  const pairing = await getRemoteCameraStore().consumeCode({
    codeHash: hashPairingCode(code),
    pairingId: randomUUID(),
    name,
    nowIso: new Date().toISOString(),
  });
  if (!pairing) return null;
  const expiresAt = nowSec() + TIMING.cameraSessionDays * 86_400;
  logEvent("camera_paired", { kioskId: pairing.kioskId, pairingId: pairing.id });
  return {
    pairing,
    cookieValue: signCameraSession(key, {
      pairingId: pairing.id,
      kioskId: pairing.kioskId,
      expiresAt,
    }),
  };
}

export type CameraAuth =
  { ok: true; pairing: Pairing } | { ok: false; reason: "missing" | "invalid" | "revoked" };

/** Camera cookie → active pairing. Revocation is checked on every call. */
export async function authenticateCameraRequest(request: Request): Promise<CameraAuth> {
  const key = cameraKey();
  const value = readCookie(request, CAMERA_COOKIE);
  if (!key || !value) return { ok: false, reason: "missing" };
  const claims = verifyCameraSession(key, value, nowSec());
  if (!claims) return { ok: false, reason: "invalid" };
  const pairing = await getRemoteCameraStore().get(claims.pairingId);
  if (!pairing || pairing.kioskId !== claims.kioskId) return { ok: false, reason: "invalid" };
  if (pairing.revokedAt) return { ok: false, reason: "revoked" };
  return { ok: true, pairing };
}

export function cameraCookieHeader(request: Request, value: string | null): string {
  const config = getServerConfig();
  const secure = secureCookies(config, request);
  return [
    `${CAMERA_COOKIE}=${value ? encodeURIComponent(value) : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${value ? TIMING.cameraSessionDays * 86_400 : 0}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Common gate: the rollback switch, same origin for mutations, and (when given) a rate limit. */
export function cameraGate(
  request: Request,
  limiter: RateLimiter | null,
  key?: string,
): Response | null {
  if (remoteCameraDisabled()) return jsonError(404, "not found");
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if (mutation && !isSameOrigin(request, [getServerConfig().publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (limiter && !limiter.take(key ?? clientIp(request)))
    return jsonError(429, "too many requests");
  return null;
}
