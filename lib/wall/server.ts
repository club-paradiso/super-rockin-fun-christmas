import "server-only";
import { WALL_CONFIG } from "@/config/wall";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import type { WallFeed } from "./states";

/**
 * The wall's view of the world. Emergency switches are applied here, on the server, so a paused
 * or holding wall is never sent a photo id in the first place.
 */
export async function wallFeed(): Promise<WallFeed> {
  const settings = await getBackend().settings.get();
  if (settings.showHoldingScreen) return { mode: "holding", photos: [] };
  if (settings.pauseWall) return { mode: "paused", photos: [] };
  return { mode: "live", photos: await getPhotoService().wallPhotos(WALL_CONFIG.feedLimit) };
}

/** Image bytes for the wall, or null when the wall is not live or the photo is not eligible. */
export async function wallImage(photoId: string) {
  const settings = await getBackend().settings.get();
  if (settings.showHoldingScreen || settings.pauseWall) return null;
  return getPhotoService().wallImage(photoId);
}
