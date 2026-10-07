import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { getBackend } from "@/lib/storage/server";
import type { SettingsPatch } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute("admin_settings", async () =>
  NextResponse.json({ settings: await getBackend().settings.get() }, { headers: NO_STORE }),
);

/**
 * POST any of {"pauseSubmissions","pauseWall","showHoldingScreen"} as booleans. Audited.
 * pauseSubmissions stops NEW media-wall submissions only; photography and QR delivery continue.
 */
export const POST = staffRoute("admin_settings_update", async (request, { staff }) => {
  const body = await readJson<Record<string, unknown>>(request);
  const patch: SettingsPatch = {};
  for (const key of ["pauseSubmissions", "pauseWall", "showHoldingScreen"] as const) {
    if (body && key in body) {
      if (typeof body[key] !== "boolean") return jsonError(400, `${key} must be boolean`);
      patch[key] = body[key] as boolean;
    }
  }
  if (!Object.keys(patch).length) return jsonError(400, "nothing to change");
  const settings = await getBackend().settings.update(patch, staff.userId);
  logEvent("settings_updated", { staffId: staff.userId, ...patch });
  return NextResponse.json({ settings }, { headers: NO_STORE });
});
