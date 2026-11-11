import "server-only";
import { logEvent } from "@/lib/server/log";
import type { VideoMime } from "@/lib/video/format";
import { toGuestPhoto } from "./photo-service";
import { getPhotoService } from "./server";
import type { GuestPhoto } from "./types";

/**
 * The only way guest-facing routes look photos up. Unknown, malformed, expired and deleted all
 * collapse to null so a response never reveals whether a guessed token ever existed.
 */
export async function findGuestPhoto(token: string): Promise<GuestPhoto | null> {
  const result = await getPhotoService().resolve(token);
  if (result.ok) return toGuestPhoto(result.row);
  if (result.reason === "expired" || result.reason === "deleted") {
    logEvent("guest_link_unavailable", { reason: result.reason });
  }
  return null;
}

export async function readGuestImage(
  token: string,
): Promise<{ photo: GuestPhoto; data: Uint8Array } | null> {
  const result = await getPhotoService().read(token);
  if ("data" in result) return result;
  if (!result.ok && (result.reason === "expired" || result.reason === "deleted")) {
    logEvent("guest_image_unavailable", { reason: result.reason });
  }
  return null;
}

/**
 * The session video behind a guest link (D72). Null for every unavailable case, including a photo
 * that simply has no video: the route answers all of them with the same 404.
 */
export async function readGuestVideo(
  token: string,
): Promise<{ mime: VideoMime; createdAt: string; data: Uint8Array } | null> {
  const result = await getPhotoService().readVideo(token);
  if ("data" in result) return result;
  if (!result.ok && (result.reason === "expired" || result.reason === "deleted")) {
    logEvent("guest_video_unavailable", { reason: result.reason });
  }
  return null;
}
