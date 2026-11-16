import "server-only";
import { NextResponse } from "next/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import {
  authenticateCameraRequest,
  cameraGate,
  getIceConfig,
  getRemoteCameraStore,
} from "./server";
import { parseSignal, type SignalFrom, type SignalTo } from "./protocol";
import type { Pairing } from "./store";
import { isOnline } from "./store";

export const MAX_SIGNAL_BODY = 40_000;

/** Camera page (iPhone) routes: signed camera cookie + live pairing. */
export function cameraRoute(
  name: string,
  limiter: RateLimiter,
  handler: (request: Request, pairing: Pairing) => Promise<Response>,
) {
  return route(name, async (request: Request) => {
    const denied = cameraGate(request, limiter);
    if (denied) return denied;
    const auth = await authenticateCameraRequest(request);
    if (!auth.ok) return jsonError(401, auth.reason === "revoked" ? "revoked" : "not_paired");
    return handler(request, auth.pairing);
  });
}

/** Booth (iPad) routes: enrolled kiosk cookie, and the kiosk's active pairing if it has one. */
export function kioskCameraRoute(
  name: string,
  limiter: RateLimiter,
  handler: (
    request: Request,
    ctx: { kioskId: string; pairing: Pairing | null; headers: Record<string, string> },
  ) => Promise<Response>,
) {
  return route(name, async (request: Request) => {
    const denied = cameraGate(request, null);
    if (denied) return denied;
    const auth = await authenticateKioskRequest(request);
    if (!auth.ok) return jsonError(401, "kiosk not enrolled");
    const key = auth.kioskId ?? "dev";
    if (!limiter.take(key)) return jsonError(429, "too many requests");
    const headers: Record<string, string> = { ...NO_STORE };
    if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
    const pairing = auth.kioskId ? await getRemoteCameraStore().activeForKiosk(auth.kioskId) : null;
    return handler(request, { kioskId: auth.kioskId ?? "dev", pairing, headers });
  });
}

export async function readLimitedJson(request: Request, max = MAX_SIGNAL_BODY): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  const text = await request.text().catch(() => "");
  if (text.length > max) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Shared by both sides: store one validated message for the peer. */
export async function postSignal(
  request: Request,
  pairing: Pairing,
  from: SignalFrom,
  to: SignalTo,
  headers: Record<string, string> = NO_STORE,
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const body = (await readLimitedJson(request)) as { message?: unknown } | null;
  const message = parseSignal(body?.message, from);
  if (!message) return jsonError(400, "invalid message");
  const seq = await getRemoteCameraStore().push({
    pairingId: pairing.id,
    kioskId: pairing.kioskId,
    from,
    to,
    message,
    nowIso: new Date().toISOString(),
  });
  return NextResponse.json({ seq }, { headers });
}

export async function getSignals(
  request: Request,
  pairing: Pairing,
  to: SignalTo,
  headers: Record<string, string> = NO_STORE,
  { touch }: { touch: boolean } = { touch: false },
): Promise<Response> {
  const url = new URL(request.url);
  const afterRaw = Number(url.searchParams.get("after") ?? 0);
  const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
  const store = getRemoteCameraStore();
  const nowIso = new Date().toISOString();
  if (touch) await store.touch(pairing.id, nowIso);
  const messages = await store.poll({ pairingId: pairing.id, to, afterSeq: after, nowIso });
  const wantsIce = url.searchParams.get("ice") === "1";
  const body: Record<string, unknown> = {
    now: nowIso,
    messages: messages.map((m) => ({ seq: m.seq, from: m.from, message: m.message, at: m.at })),
    last: messages.length ? messages[messages.length - 1]!.seq : after,
  };
  if (wantsIce) body.iceServers = getIceConfig().servers;
  return NextResponse.json(body, { headers });
}

export function pairingStatus(pairing: Pairing | null, nowMs: number) {
  if (!pairing) return { paired: false, online: false, state: "offline" as const, name: null };
  const online = isOnline(pairing, nowMs);
  return {
    paired: true,
    online,
    state: online ? pairing.report.state : ("offline" as const),
    name: pairing.name,
    mode: pairing.report.mode,
  };
}
