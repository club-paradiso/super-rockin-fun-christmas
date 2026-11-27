import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { getBackend } from "@/lib/storage/server";
import { getServerConfig } from "@/lib/server/env";
import { MODERATION_MODES, type ModerationMode } from "@/lib/storage/types";
import type { SettingsPatch, WallForce } from "@/lib/storage/types";
import { DEFAULT_WALL_THEME, WALL_THEMES } from "@/config/wall-themes";
import { cameraEngineProblem, normalizeCameraEngine } from "@/lib/camera-engine/settings";
import { isValidHours } from "@/lib/wall/hours";
import {
  HALF_LIFE_MINUTES,
  ROTATE_MINUTES,
  SHOW_SECONDS,
  normalizeLook,
  type WallLook,
} from "@/lib/wall/themes";

const FORCES: WallForce[] = ["auto", "on", "off"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute("admin_settings", async () =>
  NextResponse.json({ settings: await getBackend().settings.get() }, { headers: NO_STORE }),
);

/**
 * POST any of {"pauseSubmissions","pauseWall","showHoldingScreen"} as booleans,
 * "wallForce": "auto" | "on" | "off", "wallHours": {"start":"HH:MM","end":"HH:MM"} | null,
 * "wallPublic": boolean (D86), "photoLooks": boolean (colour looks on the booth's photos),
 * "mobileUpload": boolean (「내 사진으로 참여하기」 on the booth cover, off by default),
 * "wallLook": {"theme","rotate","rotateMinutes","rotation":[theme ids]} (D85),
 * "wallPace": {"showSeconds","halfLifeMinutes"} (D92; stored inside the look),
 * "moderationMode": "manual" | "auto" (D95; "auto" is refused with 409 while no AI provider is
 * configured on this server, so the switch can never promise a check that is not there),
 * "cameraEngine": the whole camera-engine setting (lib/camera-engine/settings.ts: every field,
 * nothing else; a booth takes it up at its next guest). Audited.
 * pauseSubmissions stops NEW media-wall submissions only; photography and QR delivery continue.
 */
export const POST = staffRoute("admin_settings_update", async (request, { staff }) => {
  const body = await readJson<Record<string, unknown>>(request);
  const patch: SettingsPatch = {};
  for (const key of [
    "pauseSubmissions",
    "pauseWall",
    "showHoldingScreen",
    "wallPublic",
    "photoLooks",
    "mobileUpload",
  ] as const) {
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
  if (body && "moderationMode" in body) {
    if (!MODERATION_MODES.includes(body.moderationMode as ModerationMode))
      return jsonError(400, "moderationMode must be manual or auto");
    if (body.moderationMode === "auto" && !getServerConfig().aiModeration)
      return jsonError(409, "ai_not_configured");
    patch.moderationMode = body.moderationMode as ModerationMode;
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
  if (body && "cameraEngine" in body) {
    const problem = cameraEngineProblem(body.cameraEngine);
    if (problem) return jsonError(400, problem);
    patch.cameraEngine = normalizeCameraEngine(body.cameraEngine);
  }
  if (body && "wallLook" in body) {
    const problem = wallLookProblem(body.wallLook);
    if (problem) return jsonError(400, problem);
    patch.wallLook = normalizeLook(body.wallLook, WALL_THEMES, DEFAULT_WALL_THEME);
  }
  if (body && "wallPace" in body) {
    const problem = wallPaceProblem(body.wallPace);
    if (problem) return jsonError(400, problem);
    patch.wallLook = {
      ...(patch.wallLook ?? (await currentLook())),
      ...(body.wallPace as Pick<WallLook, "showSeconds" | "halfLifeMinutes">),
    };
  } else if (patch.wallLook) {
    // The background form knows nothing about the pace: saving a background keeps it.
    const { showSeconds, halfLifeMinutes } = await currentLook();
    patch.wallLook = { ...patch.wallLook, showSeconds, halfLifeMinutes };
  }
  if (!Object.keys(patch).length) return jsonError(400, "nothing to change");
  const settings = await getBackend().settings.update(patch, staff.userId);
  const { wallHours, wallLook, cameraEngine, ...flags } = patch;
  logEvent("settings_updated", {
    staffId: staff.userId,
    ...flags,
    // The mode only: the offsets are in the audit row.
    ...(cameraEngine && { cameraEngine: cameraEngine.mode }),
    ...(wallLook && {
      wallTheme: wallLook.theme,
      wallRotate: wallLook.rotate
        ? `${wallLook.rotateMinutes}m:${wallLook.rotation.join(",")}`
        : "off",
      wallShowSeconds: wallLook.showSeconds,
      wallHalfLifeMinutes: wallLook.halfLifeMinutes,
    }),
    ...(wallHours !== undefined && {
      wallHours: wallHours ? `${wallHours.start}-${wallHours.end}` : null,
    }),
  });
  return NextResponse.json({ settings }, { headers: NO_STORE });
});

async function currentLook(): Promise<WallLook> {
  const settings = await getBackend().settings.get();
  return normalizeLook(settings.wallLook, WALL_THEMES, DEFAULT_WALL_THEME);
}

function wallPaceProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "wallPace must be an object";
  const pace = raw as Record<string, unknown>;
  const whole = (v: unknown, r: { min: number; max: number }) =>
    typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max;
  if (!whole(pace.showSeconds, SHOW_SECONDS))
    return `wallPace.showSeconds must be a whole number from ${SHOW_SECONDS.min} to ${SHOW_SECONDS.max}`;
  if (!whole(pace.halfLifeMinutes, HALF_LIFE_MINUTES))
    return `wallPace.halfLifeMinutes must be a whole number from ${HALF_LIFE_MINUTES.min} to ${HALF_LIFE_MINUTES.max}`;
  return null;
}

/** Strict on the way in (a typo must not silently become the default theme). */
function wallLookProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "wallLook must be an object";
  const look = raw as Partial<Record<keyof WallLook, unknown>>;
  const known = new Set(WALL_THEMES.map((t) => t.id));
  if (typeof look.theme !== "string" || !known.has(look.theme))
    return "wallLook.theme must be a known theme id";
  if (typeof look.rotate !== "boolean") return "wallLook.rotate must be boolean";
  if (
    typeof look.rotateMinutes !== "number" ||
    !Number.isInteger(look.rotateMinutes) ||
    look.rotateMinutes < ROTATE_MINUTES.min ||
    look.rotateMinutes > ROTATE_MINUTES.max
  )
    return `wallLook.rotateMinutes must be a whole number from ${ROTATE_MINUTES.min} to ${ROTATE_MINUTES.max}`;
  if (
    !Array.isArray(look.rotation) ||
    look.rotation.length > WALL_THEMES.length ||
    !look.rotation.every((id) => typeof id === "string" && known.has(id)) ||
    new Set(look.rotation).size !== look.rotation.length
  )
    return "wallLook.rotation must be a list of different known theme ids";
  if (look.rotate && look.rotation.length < 2)
    return "wallLook.rotation needs at least two themes to rotate";
  return null;
}
