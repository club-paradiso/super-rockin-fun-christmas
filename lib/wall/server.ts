import "server-only";
import { WALL_CONFIG } from "@/config/wall";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import { feedSize, rotationOrder } from "./rotation";
import type { WallFeed } from "./states";

/** Upper bound on eligible photos read per poll (the event expects ~5,000 in total). */
const MAX_ELIGIBLE = 20_000;

/**
 * The wall's view of the world. Emergency switches are applied here, on the server, so a paused
 * or holding wall is never sent a photo id in the first place.
 *
 * `onWall` are the ids the display is showing right now. They stay in the answer while they are
 * still eligible, even when the rotation has moved on, so the wall never has to drop a photo in
 * the middle of its turn just because it fell out of the top of the order.
 */
export async function wallFeed(onWall: readonly string[] = []): Promise<WallFeed> {
  const backend = getBackend();
  const settings = await backend.settings.get();
  if (settings.showHoldingScreen)
    return { mode: "holding", ordering: "fair", photos: [], showNow: [] };
  if (settings.pauseWall) return { mode: "paused", ordering: "fair", photos: [], showNow: [] };

  const [eligible, exposures, queue] = await Promise.all([
    getPhotoService().wallPhotos(MAX_ELIGIBLE),
    backend.wall.exposures(),
    backend.wall.showNowQueue(),
  ]);
  const byId = new Map(eligible.map((p) => [p.id, p]));
  const withOnWall = (ids: string[]) => {
    const picked = new Set(ids);
    for (const id of onWall) {
      if (!byId.has(id) || picked.has(id)) continue;
      ids.push(id);
      picked.add(id);
    }
    return ids.map((id) => byId.get(id)!);
  };

  if (!exposures) {
    return {
      mode: "live",
      ordering: "newest",
      photos: withOnWall(eligible.slice(0, WALL_CONFIG.feedLimit).map((p) => p.id)),
      showNow: [],
    };
  }
  const showNow = queue.map((r) => r.photoId).filter((id) => byId.has(id));
  const order = rotationOrder({
    eligible,
    exposures: new Map(exposures.map((e) => [e.photoId, e])),
    showNow,
  });
  return {
    mode: "live",
    ordering: "fair",
    photos: withOnWall(order.slice(0, feedSize(WALL_CONFIG.slots))),
    showNow,
  };
}

/** Image bytes for the wall, or null when the wall is not live or the photo is not eligible. */
export async function wallImage(photoId: string) {
  const settings = await getBackend().settings.get();
  if (settings.showHoldingScreen || settings.pauseWall) return null;
  return getPhotoService().wallImage(photoId);
}

/** The display reports what it put up (`shown`) and what is up now (`onWall`). */
export async function wallReport(shown: readonly string[], onWall: readonly string[]) {
  await getBackend().wall.report({
    shown: [...shown],
    onWall: [...onWall],
    at: new Date().toISOString(),
  });
}
