/**
 * Media-wall state model (Phase 4). Defined now so the kiosk, admin and wall agree on names;
 * the renderer that uses it is not built yet.
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
