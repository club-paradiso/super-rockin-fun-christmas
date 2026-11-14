import type { CameraErrorKind } from "@/lib/camera";
import type { KioskPhase } from "./machine";

/**
 * What the booth does about the camera when its page is shown again after being in the
 * background. A tablet browser (iPadOS Safari above all) stops or mutes the camera while another
 * tab or app is in front; without this the guest comes back to a frozen or black preview.
 *
 * - "restart": the ready screen has no usable picture. Take the camera again (CAMERA_RESTART).
 * - "retry":   the camera was lost while the page was away. Try once more (CAMERA_RETRY) instead
 *              of leaving the guest on the error screen.
 * - null:      nothing to do. A refused permission or a browser without a camera is not retried
 *              (the answer would be the same); a countdown or capture takes the camera again by
 *              itself; and a start that is already under way is left alone.
 */
export type CameraRecovery = "restart" | "retry" | null;

export function cameraRecovery(input: {
  phase: KioskPhase;
  cameraError: CameraErrorKind | null;
  /** The provider has a live track. */
  active: boolean;
  /** The provider's track is live but muted by the browser. */
  stalled: boolean;
}): CameraRecovery {
  if (input.phase === "ready") return !input.active || input.stalled ? "restart" : null;
  if (input.phase === "camera-error")
    return input.cameraError === "missing" || input.cameraError === "failed" ? "retry" : null;
  return null;
}

/**
 * How long after the page is shown the booth looks at the camera. Safari unmutes a healthy
 * stream a moment after it returns to the front; looking too early would restart it for nothing.
 */
export const CAMERA_RESUME_GRACE_MS = 800;
