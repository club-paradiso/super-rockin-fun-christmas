/**
 * Media-wall state model. Shared by the wall renderer (components/wall), the feed endpoint and
 * the scheduler (lib/wall/scheduler.ts).
 */

export type WallScreenState = "BOOT" | "EMPTY" | "ACTIVE" | "OFFLINE" | "MAINTENANCE";

/** Lifecycle of one photo on the wall. Not a slideshow: photos arrive, live a while, leave. */
export type WallPhotoPhase = "ENTER" | "VISIBLE" | "EXIT" | "COOLDOWN";

export const WALL_PHOTO_NEXT: Record<WallPhotoPhase, WallPhotoPhase | null> = {
  ENTER: "VISIBLE",
  VISIBLE: "EXIT",
  EXIT: "COOLDOWN",
  COOLDOWN: null, // eligible to be scheduled again
};

export function wallScreenState(input: {
  booted: boolean;
  online: boolean;
  maintenance: boolean;
  approvedCount: number;
}): WallScreenState {
  if (!input.booted) return "BOOT";
  if (input.maintenance) return "MAINTENANCE";
  if (!input.online) return "OFFLINE";
  return input.approvedCount > 0 ? "ACTIVE" : "EMPTY";
}

/**
 * What the server lets the wall do right now. `holding` (SHOW HOLDING SCREEN) wins over `paused`
 * (PAUSE MEDIA WALL), which wins over `closed` (outside opening hours, lib/wall/hours.ts). None of
 * them sends any photos.
 */
export type WallFeedMode = "live" | "paused" | "holding" | "closed";

/**
 * Who is asking (D86). `display`: an enrolled venue screen; it reports what it shows and is sent
 * every eligible photo. `public`: anyone who opened the wall address; it is sent only photos
 * whose consent covers the public address, and it never reports anything back.
 */
export type WallAudience = "display" | "public";

export interface WallFeed {
  mode: WallFeedMode;
  audience: WallAudience;
  /** The background on the wall right now (config/wall-themes.ts), in every mode (D85). */
  theme: string;
  /**
   * `fair`: photos are in rotation order (lib/wall/rotation.ts); the wall takes the first usable
   * one. `newest`: newest first, no server-side exposure history (cloud fallback, D52).
   */
  ordering: "fair" | "newest";
  photos: { id: string; frameId: string; createdAt: string }[];
  /** Staff asked for these now: the wall makes room for them at once. */
  showNow: string[];
  /** `closed` only: when the wall opens again ("HH:MM"), if there are opening hours. */
  opensAt?: string | null;
}
