import { get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import { LIGHT, TICKET_COLORS } from "@/lib/studio/ticket";

/**
 * The guest's framed photo as an Instagram story picture (1080 × 1920, 9:16), drawn on the phone
 * from the photo the page already shows. Nothing is sent anywhere.
 *
 * The photo is fitted whole (never cropped, never stretched) inside the part of the story that
 * Instagram's own top bar (profile, progress) and bottom bar (reply box) leave clear, on the brand
 * backdrop, with the one top-left light's shadow (D101) and a short brand line under it.
 */
export const STORY_SIZE = { width: 1080, height: 1920 } as const;

/**
 * What Instagram covers on a 1080 × 1920 story: about 250 px at the top and 340 px at the bottom.
 * Everything we draw stays between these lines.
 */
export const STORY_SAFE = { top: 250, bottom: STORY_SIZE.height - 340 } as const;

/** The box the photo is fitted into (centred in it). */
export const STORY_PHOTO_BOX = { x: 90, y: STORY_SAFE.top, w: 900, h: 1220 } as const;

/** Baseline of the brand line under the photo. */
const CAPTION_Y = 1540;
const CAPTION_FONT = `600 40px "Cormorant Garamond", "Times New Roman", serif`;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The photo's rectangle: its own shape, as large as fits in the box, centred. */
export function storyPhotoRect(width: number, height: number): Rect {
  if (!(width > 0) || !(height > 0)) throw new RangeError("photo has no size");
  const box = STORY_PHOTO_BOX;
  const scale = Math.min(box.w / width, box.h / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return {
    x: Math.round(box.x + (box.w - w) / 2),
    y: Math.round(box.y + (box.h - h) / 2),
    w,
    h,
  };
}

export function storyCaption(event: string): string {
  return `STUDIO SHALOM · ${event}`;
}

export function drawStoryImage(
  createCanvas: CanvasFactory,
  photo: { image: CanvasImageSource; width: number; height: number },
  event: string,
): CanvasLike {
  const canvas = createCanvas(STORY_SIZE.width, STORY_SIZE.height);
  const ctx = get2d(canvas);
  const C = TICKET_COLORS;

  ctx.fillStyle = C.backdrop;
  ctx.fillRect(0, 0, STORY_SIZE.width, STORY_SIZE.height);

  const r = storyPhotoRect(photo.width, photo.height);
  // The shadow is cast by a filled rectangle under the photo, so a transparent PNG corner never
  // gets a shadow of its own.
  ctx.save();
  ctx.shadowColor = LIGHT.color;
  ctx.shadowOffsetX = LIGHT.x;
  ctx.shadowOffsetY = LIGHT.y;
  ctx.shadowBlur = LIGHT.blur;
  ctx.fillStyle = C.paper;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo.image, r.x, r.y, r.w, r.h);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.ink;
  ctx.globalAlpha = 0.75;
  ctx.font = CAPTION_FONT;
  ctx.fillText(storyCaption(event), STORY_SIZE.width / 2, CAPTION_Y);
  ctx.globalAlpha = 1;
  return canvas;
}

/** The font the brand line needs (canvas does not wait for web fonts). */
export function storyFontRequest(event: string): { spec: string; text: string } {
  return { spec: `600 40px "Cormorant Garamond"`, text: storyCaption(event) };
}

/** "studio-shalom-story-2026-12-24.jpg" (no personal data in the name). */
export function storyFileName(createdAt: string): string {
  return `studio-shalom-story-${createdAt.slice(0, 10)}.jpg`;
}
