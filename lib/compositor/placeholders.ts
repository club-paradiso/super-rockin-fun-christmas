import { createDomCanvas } from "@/lib/canvas";
import type { ComposeImage } from "./types";

/**
 * Sample photos for a frame picker before the guest has photos (a plain warm-grey gradient with
 * "PHOTO n"). The same compositor draws them, so the thumbnail is the frame the guest will get.
 * Shared by the booth and the phone page (D103) so both pickers look the same.
 */
export function placeholderPhotos(count = 6): ComposeImage[] {
  return Array.from({ length: count }, (_, i) => {
    const canvas = createDomCanvas(400, 300) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 400, 300);
    gradient.addColorStop(0, "#8a7565");
    gradient.addColorStop(0.71, "#6b574a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = "#f6eee4";
    ctx.font = "18px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`PHOTO ${i + 1}`, 200, 156);
    return { source: canvas, width: 400, height: 300 };
  });
}
