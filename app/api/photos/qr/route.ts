import { NextResponse } from "next/server";
import { getCloudSync } from "@/lib/cloud/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { isUuid } from "@/lib/server/validate";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The kiosk asks every few seconds while one guest waits for a "QR 준비 중" photo.
const limiter = new RateLimiter(60, 60_000);

/**
 * Hub + cloud: POST {"sessionId"} from the kiosk that took the photo → 200 with the cloud guest
 * link once its copy is in the cloud, or 202 {qr:"pending"} while it is not. 410 when there will
 * never be one (the photo or its copy was deleted).
 */
export const POST = route("upload_qr", async (request: Request) => {
  if (!isSameOrigin(request, [getServerConfig().publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  const sync = getCloudSync();
  if (!sync) return jsonError(404, "no cloud configured");
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  if (!isUuid(body?.sessionId)) return jsonError(400, "invalid session id");
  const row = await getBackend().photos.findBySessionId(body.sessionId);
  if (!row || row.kioskId !== auth.kioskId) return jsonError(404, "not found");
  const outcome = await sync.link(row.id);
  if (outcome.ok) return NextResponse.json(outcome.link, { headers: NO_STORE });
  if (outcome.reason === "gone") return jsonError(410, "gone");
  return NextResponse.json({ qr: "pending" }, { status: 202, headers: NO_STORE });
});
