import "server-only";
import { resolveRetouchLevel } from "@/config/retouch";
import { resolveCameraMode } from "@/lib/camera";
import { getAiReview } from "@/lib/moderation/server";
import { getServerConfig } from "@/lib/server/env";
import { getBackend } from "@/lib/storage/server";

export async function kioskBootstrap(
  camera?: string,
  query: { retouch?: string; retouchHud?: string; perf?: string } = {},
) {
  const settings = await getBackend().settings.get();
  return {
    cameraMode: resolveCameraMode(camera, process.env.NEXT_PUBLIC_CAMERA_MODE),
    initialWallSubmissions: settings.pauseSubmissions ? ("paused" as const) : ("open" as const),
    initialWallPublic: settings.wallPublic,
    initialAiReview: await getAiReview().active(),
    initialPhotoLooks: settings.photoLooks,
    // 「내 사진으로 참여하기」: hidden on the cover unless staff turned it on.
    initialMobileUpload: settings.mobileUpload,
    // 「카메라 자동 보정」 (lib/camera-engine): off unless staff turned it on.
    initialCameraEngine: settings.cameraEngine,
    staffHelp: getServerConfig().staffAuth?.mode === "pin",
    // The server's clock at page load: the booth dates photos by it, never by the tablet's own.
    serverNow: new Date().toISOString(),
    // Skin retouch: off unless SKIN_RETOUCH (or `?retouch=` on this URL) names a level.
    skinRetouch: resolveRetouchLevel(query.retouch, process.env.SKIN_RETOUCH),
    // Timings on screen, for measuring a device: always in development, by `?retouchHud=1` else.
    retouchHud: query.retouchHud === "1" || process.env.NODE_ENV !== "production",
    // 속도 기록 on the first screen (`?perf=1`), for a booth without the staff help menu.
    perfHud: query.perf === "1",
  };
}
