import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { getRemoteCameraStore } from "@/lib/remote-camera/server";
import { parseReport } from "@/lib/remote-camera/protocol";
import { cameraRoute, readLimitedJson } from "@/lib/remote-camera/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(120, 60_000);

/** Camera page → staff: what the camera is doing. Numbers and codes only, never a picture. */
export const POST = cameraRoute("camera_status", limiter, async (request, pairing) => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const body = (await readLimitedJson(request, 20_000)) as { report?: unknown } | null;
  const report = parseReport(body?.report);
  if (!report) return jsonError(400, "invalid report");
  await getRemoteCameraStore().setReport(pairing.id, report, new Date().toISOString());
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
