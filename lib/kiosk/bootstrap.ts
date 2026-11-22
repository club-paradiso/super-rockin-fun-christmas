import "server-only";
import { resolveCameraMode } from "@/lib/camera";
import { getAiReview } from "@/lib/moderation/server";
import { getServerConfig } from "@/lib/server/env";
import { getBackend } from "@/lib/storage/server";

export async function kioskBootstrap(camera?: string) {
  const settings = await getBackend().settings.get();
  return {
    cameraMode: resolveCameraMode(camera, process.env.NEXT_PUBLIC_CAMERA_MODE),
    initialWallSubmissions: settings.pauseSubmissions ? ("paused" as const) : ("open" as const),
    initialWallPublic: settings.wallPublic,
    initialAiReview: await getAiReview().active(),
    staffHelp: getServerConfig().staffAuth?.mode === "pin",
    // The server's clock at page load: the booth dates photos by it, never by the tablet's own.
    serverNow: new Date().toISOString(),
  };
}
