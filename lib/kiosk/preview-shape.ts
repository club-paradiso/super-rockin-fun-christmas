import type { FrameDefinition } from "@/lib/compositor/types";

/**
 * The live picture shows the part of each shot the chosen frame keeps (a user request,
 * 2026-11-27: "촬영시 카메라 화면이 너무 작아. 키오스크는 세로"). Every shot is still taken at
 * `KIOSK_CONFIG.captureAspect` (4:3) and put into its slot exactly as before: `composeFrame`
 * cover-crops it, centred (`coverCrop`; booth shots carry no focus). The preview is a window of
 * the slot's shape over the unchanged 4:3 view, centred the same way, so it shows that crop and
 * nothing else: for a square or tall slot the guest sees the part that will be printed, larger;
 * for a wide slot they see where the top and bottom will be cut. Nothing about the photo, the
 * composite or the upload changes.
 *
 * Only when every slot of the frame has the same shape (within `SAME_SHAPE`, 0.2 %): a frame whose slots
 * differ cannot know which slot a shot will go to (the guest orders them afterwards), so it keeps
 * the whole 4:3 view.
 */
export const SAME_SHAPE = 0.002;

export function previewAspect(frame: FrameDefinition, captureAspect: number): number {
  const slots = frame.slots;
  if (!slots.length) return captureAspect;
  const first = slots[0]!.width / slots[0]!.height;
  if (!(first > 0) || !Number.isFinite(first)) return captureAspect;
  for (const slot of slots) {
    const aspect = slot.width / slot.height;
    if (!(Math.abs(aspect - first) / first <= SAME_SHAPE)) return captureAspect;
  }
  return first;
}

/**
 * How large the 4:3 view is inside a window of `windowAspect`, as a share of the window's width
 * and height (at least 1 each: the view always covers the window, centred). The part of the view
 * inside the window is then the centred `coverCrop` of a 4:3 shot to the window's shape.
 */
export function previewViewSize(
  windowAspect: number,
  captureAspect: number,
): { width: number; height: number } {
  return windowAspect < captureAspect
    ? { width: captureAspect / windowAspect, height: 1 }
    : { width: 1, height: windowAspect / captureAspect };
}
