import "server-only";
import { WALL_CONFIG } from "@/config/wall";
import { DEFAULT_WALL_THEME, WALL_THEMES } from "@/config/wall-themes";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import { wallOpen } from "./hours";
import { feedSize, rotationOrder } from "./rotation";
import type { WallAudience, WallFeed } from "./states";
import { activeThemeId, normalizeLook } from "./themes";

/** Upper bound on eligible photos read per poll (the event expects ~5,000 in total). */
const MAX_ELIGIBLE = 20_000;

/**
 * The wall's view of the world. Emergency switches are applied here, on the server, so a paused
 * or holding wall is never sent a photo id in the first place.
 *
 * `onWall` are the ids the display is showing right now. They stay in the answer while they are
 * still eligible, even when the rotation has moved on, so the wall never has to drop a photo in
 * the middle of its turn just because it fell out of the top of the order.
 *
 * `audience` (D86): an anonymous viewer of the wall address is `public`. It gets the same
 * switches and the same background, but only photos whose consent covers the public address, and
 * none at all while the public wall is switched off. It always gets the newest photos (the wall
 * itself rotates through them): the fair order needs exposure reports, and nothing an anonymous
 * viewer sends may change the rotation. The exposure log and the show-now queue are only ever
 * written by /api/wall/shown, which needs an enrolled display.
 */
export async function wallFeed(
  onWall: readonly string[] = [],
  /** Photos the display shows at once (its scene decides); sizes the answer. */
  slots: number = WALL_CONFIG.slots,
  audience: WallAudience = "display",
): Promise<WallFeed> {
  const backend = getBackend();
  const settings = await backend.settings.get();
  const now = new Date();
  const base = {
    audience,
    theme: activeThemeId(
      normalizeLook(settings.wallLook, WALL_THEMES, DEFAULT_WALL_THEME),
      now.getTime(),
    ),
    ordering: "fair" as const,
    photos: [],
    showNow: [],
  };
  if (settings.showHoldingScreen) return { ...base, mode: "holding" };
  if (settings.pauseWall) return { ...base, mode: "paused" };
  const hours = wallOpen(settings, now, WALL_CONFIG.timeZone);
  if (!hours.open) return { ...base, mode: "closed", opensAt: hours.opensAt };
  const publicOnly = audience === "public";
  // Public wall switched off: the address still shows the scene, with no photos.
  if (publicOnly && !settings.wallPublic) return { ...base, mode: "live", ordering: "newest" };

  if (publicOnly) {
    const photos = await getPhotoService().wallPhotos(MAX_ELIGIBLE, true);
    return {
      ...base,
      mode: "live",
      ordering: "newest",
      photos: photos.slice(0, WALL_CONFIG.feedLimit),
    };
  }

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
      ...base,
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
    ...base,
    mode: "live",
    ordering: "fair",
    photos: withOnWall(order.slice(0, feedSize(slots))),
    showNow,
  };
}

/** Image bytes for the wall, or null when the wall is not live or the photo is not eligible. */
export async function wallImage(photoId: string, audience: WallAudience = "display") {
  const settings = await getBackend().settings.get();
  if (settings.showHoldingScreen || settings.pauseWall) return null;
  if (!wallOpen(settings, new Date(), WALL_CONFIG.timeZone).open) return null;
  const publicOnly = audience === "public";
  if (publicOnly && !settings.wallPublic) return null;
  return getPhotoService().wallImage(photoId, publicOnly);
}

/** The display reports what it put up (`shown`) and what is up now (`onWall`). */
export async function wallReport(shown: readonly string[], onWall: readonly string[]) {
  await getBackend().wall.report({
    shown: [...shown],
    onWall: [...onWall],
    at: new Date().toISOString(),
  });
}

/** The background on the wall right now (for the page's first paint; the feed says it again). */
export async function currentWallTheme(): Promise<string> {
  const settings = await getBackend().settings.get();
  return activeThemeId(
    normalizeLook(settings.wallLook, WALL_THEMES, DEFAULT_WALL_THEME),
    Date.now(),
  );
}
