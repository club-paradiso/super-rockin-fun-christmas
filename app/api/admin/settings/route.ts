import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { getBackend } from "@/lib/storage/server";
import type { SettingsPatch, WallForce } from "@/lib/storage/types";
import { isValidHours } from "@/lib/wall/hours";

const FORCES: WallForce[] = ["auto", "on", "off"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute("admin_settings", async () =>
  NextResponse.json({ settings: await getBackend().settings.get() }, { headers: NO_STORE }),
);

/**
 * POST any of {"pauseSubmissions","pauseWall","showHoldingScreen"} as booleans,
 * "wallForce": "auto" | "on" | "off", "wallHours": {"start":"HH:MM","end":"HH:MM"} | null. Audited.
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
  if (body && "wallForce" in body) {
    if (!FORCES.includes(body.wallForce as WallForce))
      return jsonError(400, "wallForce must be auto, on or off");
    patch.wallForce = body.wallForce as WallForce;
  }
  if (body && "wallHours" in body) {
    if (body.wallHours !== null && !isValidHours(body.wallHours))
      return jsonError(400, "wallHours must be null or {start,end} as different HH:MM");
    patch.wallHours =
      body.wallHours === null
        ? null
        : {
            start: (body.wallHours as { start: string }).start,
            end: (body.wallHours as { end: string }).end,
          };
  }
  if (!Object.keys(patch).length) return jsonError(400, "nothing to change");
  const settings = await getBackend().settings.update(patch, staff.userId);
  const { wallHours, ...flags } = patch;
  logEvent("settings_updated", {
    staffId: staff.userId,
    ...flags,
    ...(wallHours !== undefined && {
      wallHours: wallHours ? `${wallHours.start}-${wallHours.end}` : null,
    }),
  });
  return NextResponse.json({ settings }, { headers: NO_STORE });
});
