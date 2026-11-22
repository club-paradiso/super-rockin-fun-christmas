import { FONT_STACK, get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import { HAND_FONTS, getHandFont } from "@/config/hand-fonts";
import { coverCrop, seededRandom } from "./geometry";
import { applyTone } from "./tone";
import type {
  ComposeContext,
  ComposeImage,
  FrameBackground,
  FrameDecoration,
  FrameDefinition,
  FrameSlot,
  PhotoTone,
  Rotation,
} from "./types";

export interface ComposeOptions {
  createCanvas: CanvasFactory;
  context: ComposeContext;
  /** Render at a fraction of full size (frame-picker thumbnails). Default 1. */
  scale?: number;
}

export class CompositionError extends Error {}

/**
 * Deterministically draws `images` into `frame`. Image i goes into slot i, cover-cropped so it is
 * never stretched. Same inputs → same pixels.
 */
export function composeFrame(
  frame: FrameDefinition,
  images: readonly ComposeImage[],
  { createCanvas, context, scale = 1 }: ComposeOptions,
): CanvasLike {
  if (images.length !== frame.slots.length) {
    throw new CompositionError(
      `Frame "${frame.id}" needs ${frame.slots.length} photos, got ${images.length}`,
    );
  }
  if (!(scale > 0)) throw new CompositionError(`Invalid scale ${scale}`);

  const canvas = createCanvas(
    Math.round(frame.outputWidth * scale),
    Math.round(frame.outputHeight * scale),
  );
  const ctx = get2d(canvas);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  drawBackground(ctx, frame.background, frame.outputWidth, frame.outputHeight);
  const tone = frame.photoTone ? { tone: frame.photoTone, createCanvas, scale } : null;
  const placed = photoLayers(frame);
  if (!placed) frame.slots.forEach((slot, i) => drawPhoto(ctx, slot, images[i]!, tone, scale));
  for (const deco of frame.decorations) {
    if (deco.type === "photo")
      drawPhoto(ctx, frame.slots[deco.slot]!, images[deco.slot]!, tone, scale);
    else drawDecoration(ctx, deco, context, scale);
  }

  ctx.restore();
  return canvas;
}

/**
 * True when the frame stacks its own photos. Then every slot must appear exactly once, so a
 * typo in a frame file can never drop or double a guest's photo.
 */
export function photoLayers(frame: FrameDefinition): boolean {
  const layers = frame.decorations.flatMap((d) => (d.type === "photo" ? [d.slot] : []));
  if (layers.length === 0) return false;
  const sorted = [...layers].sort((a, b) => a - b);
  if (sorted.length !== frame.slots.length || sorted.some((slot, i) => slot !== i)) {
    throw new CompositionError(`Frame "${frame.id}" must place each of its slots exactly once`);
  }
  return true;
}

/** Applies a rotation to the context (inside a save/restore pair). */
function rotate(
  ctx: CanvasRenderingContext2D,
  rotation: Rotation | undefined,
  box: { x: number; y: number; width: number; height: number },
) {
  if (!rotation?.deg) return;
  const pivot = rotation.pivot ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate((rotation.deg * Math.PI) / 180);
  ctx.translate(-pivot.x, -pivot.y);
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  bg: FrameBackground,
  width: number,
  height: number,
) {
  if (bg.type === "solid") {
    ctx.fillStyle = bg.color;
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    for (const stop of bg.stops) gradient.addColorStop(stop.offset, stop.color);
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function slotPath(ctx: CanvasRenderingContext2D, slot: FrameSlot) {
  if (slot.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      slot.x + slot.width / 2,
      slot.y + slot.height / 2,
      slot.width / 2,
      slot.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.closePath();
  } else {
    roundedRectPath(ctx, slot.x, slot.y, slot.width, slot.height, slot.radius ?? 0);
  }
}

interface ToneJob {
  tone: PhotoTone;
  createCanvas: CanvasFactory;
  scale: number;
}

/**
 * The photo, cover-cropped to the slot and toned at the output's own pixel size, so the tone is
 * computed once per output pixel. Null when the canvas cannot hand out its pixels (then the photo
 * is drawn as shot rather than not at all).
 */
function tonedPhoto(
  image: ComposeImage,
  crop: { x: number; y: number; width: number; height: number },
  slot: FrameSlot,
  job: ToneJob,
): CanvasLike | null {
  const w = Math.max(1, Math.round(slot.width * job.scale));
  const h = Math.max(1, Math.round(slot.height * job.scale));
  const canvas = job.createCanvas(w, h);
  const tctx = get2d(canvas);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(image.source, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
  const pixels = tctx.getImageData(0, 0, w, h) as ImageData | undefined;
  if (!pixels?.data) return null;
  applyTone(pixels.data, job.tone);
  tctx.putImageData(pixels, 0, 0);
  return canvas;
}

function drawPhoto(
  ctx: CanvasRenderingContext2D,
  slot: FrameSlot,
  image: ComposeImage,
  tone: ToneJob | null = null,
  scale = 1,
) {
  const crop = coverCrop(image.width, image.height, slot.width / slot.height);
  const toned = tone ? tonedPhoto(image, crop, slot, tone) : null;
  ctx.save();
  rotate(ctx, slot.rotation, slot);
  slotPath(ctx, slot);
  ctx.clip();
  if (toned) {
    ctx.drawImage(
      toned as unknown as CanvasImageSource,
      0,
      0,
      toned.width,
      toned.height,
      slot.x,
      slot.y,
      slot.width,
      slot.height,
    );
    // Hand the pixels back at once (older WebKit keeps canvas memory until then).
    toned.width = toned.height = 0;
  } else {
    ctx.drawImage(
      image.source,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      slot.x,
      slot.y,
      slot.width,
      slot.height,
    );
  }
  ctx.restore();

  if (slot.innerShadow) {
    // The shadow of a shape that covers everything but the photo, seen only inside the photo.
    // Canvas shadows ignore the transform, so blur and offset are scaled by hand.
    const { color, blur, offsetY } = slot.innerShadow;
    const pad = 4 * (blur + Math.abs(offsetY)) + 8;
    ctx.save();
    rotate(ctx, slot.rotation, slot);
    slotPath(ctx, slot);
    ctx.clip();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur * scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = offsetY * scale;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.rect(slot.x - pad, slot.y - pad, slot.width + 2 * pad, slot.height + 2 * pad);
    ctx.rect(slot.x, slot.y, slot.width, slot.height);
    ctx.fill("evenodd");
    ctx.restore();
  }

  if (slot.border && slot.border.width > 0) {
    ctx.save();
    rotate(ctx, slot.rotation, slot);
    ctx.strokeStyle = slot.border.color;
    ctx.lineWidth = slot.border.width;
    roundedRectPath(ctx, slot.x, slot.y, slot.width, slot.height, slot.radius ?? 0);
    ctx.stroke();
    ctx.restore();
  }
}

function drawDecoration(
  ctx: CanvasRenderingContext2D,
  deco: Exclude<FrameDecoration, { type: "photo" }>,
  context: ComposeContext,
  scale = 1,
) {
  ctx.save();
  switch (deco.type) {
    case "rect": {
      rotate(ctx, deco.rotation, deco);
      if (deco.stops) {
        const gradient = ctx.createLinearGradient(0, deco.y, 0, deco.y + deco.height);
        for (const stop of deco.stops) gradient.addColorStop(stop.offset, stop.color);
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = deco.color;
      }
      if (deco.shadow) {
        ctx.shadowColor = deco.shadow.color;
        ctx.shadowBlur = deco.shadow.blur;
        ctx.shadowOffsetY = deco.shadow.offsetY;
      }
      roundedRectPath(ctx, deco.x, deco.y, deco.width, deco.height, deco.radius ?? 0);
      ctx.fill();
      break;
    }
    case "image": {
      const asset = context.assets?.get(deco.src);
      if (!asset) break;
      rotate(ctx, deco.rotation, deco);
      ctx.globalAlpha = deco.opacity ?? 1;
      ctx.drawImage(asset.source, deco.x, deco.y, deco.width, deco.height);
      break;
    }
    case "text": {
      if (deco.rotation?.deg) {
        const pivot = deco.rotation.pivot ?? { x: deco.x, y: deco.y };
        rotate(
          ctx,
          { deg: deco.rotation.deg, pivot },
          { x: deco.x, y: deco.y, width: 0, height: 0 },
        );
      }
      ctx.fillStyle = deco.color;
      const family = deco.font ? `"${deco.font}", ${FONT_STACK}` : FONT_STACK;
      ctx.font = `${deco.weight ?? 500} ${deco.size}px ${family}`;
      ctx.textAlign = deco.align ?? "left";
      ctx.textBaseline = deco.baseline ?? "alphabetic";
      if (deco.letterSpacing) {
        // Not in every canvas implementation; harmless where unsupported.
        (ctx as unknown as { letterSpacing: string }).letterSpacing = `${deco.letterSpacing}px`;
      }
      if (deco.glow) {
        ctx.shadowColor = deco.glow.color;
        // Canvas shadows ignore the transform: scale the blur by hand.
        ctx.shadowBlur = deco.glow.blur * scale;
      }
      const text = deco.text
        .replaceAll("{date}", context.dateLabel)
        .replaceAll("{stamp}", context.stampLabel ?? "");
      ctx.fillText(text, deco.x, deco.y);
      break;
    }
    case "hand":
      drawHand(ctx, deco, context);
      break;
    case "stars": {
      const rand = seededRandom(deco.seed);
      ctx.fillStyle = deco.color;
      for (let i = 0; i < deco.count; i++) {
        const x = deco.area.x + rand() * deco.area.width;
        const y = deco.area.y + rand() * deco.area.height;
        const r = deco.minRadius + rand() * (deco.maxRadius - deco.minRadius);
        ctx.globalAlpha = 0.35 + rand() * 0.65;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "lights": {
      const { from, to, count, radius, colors } = deco;
      if (deco.wire) {
        ctx.strokeStyle = deco.wire;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        ctx.fillStyle = colors[i % colors.length]!;
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.arc(x, y + radius, radius * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, y + radius, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * "Christmas Village '26" in the session's font, with the heart after its end and the underline
 * under it, both placed from the text's measured width (fonts differ in width).
 */
function drawHand(
  ctx: CanvasRenderingContext2D,
  deco: Extract<FrameDecoration, { type: "hand" }>,
  context: ComposeContext,
) {
  const font = getHandFont(context.handFont) ?? HAND_FONTS[0]!;
  const rad = (deco.deg * Math.PI) / 180;
  ctx.translate(deco.x, deco.y);
  ctx.rotate(rad);
  ctx.font = `${font.weight} ${font.size * deco.scale}px "${font.family}", cursive`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = deco.color;
  const measured = ctx.measureText(deco.text)?.width;
  // About 360 px in every font at the table's sizes (a recording canvas measures nothing).
  const width = typeof measured === "number" && measured > 0 ? measured : 360 * deco.scale;
  const cy = deco.boxHeight / 2;
  if (font.stroke > 0) {
    ctx.strokeStyle = deco.color;
    ctx.lineWidth = font.stroke * deco.scale;
    ctx.lineJoin = "round";
    ctx.strokeText(deco.text, 0, cy);
  }
  ctx.fillText(deco.text, 0, cy);

  const heart = deco.heart && context.assets?.get(deco.heart.src);
  if (deco.heart && heart) {
    ctx.save();
    ctx.translate(width + deco.heart.dx, deco.heart.dy);
    ctx.rotate(((deco.heart.deg - deco.deg) * Math.PI) / 180);
    ctx.drawImage(
      heart.source,
      -deco.heart.padX,
      -deco.heart.padY,
      deco.heart.width,
      deco.heart.height,
    );
    ctx.restore();
  }
  const line = deco.underline && context.assets?.get(deco.underline.src);
  if (deco.underline && line) {
    const length = Math.max(0, width - deco.underline.dx - deco.underline.trimEnd);
    ctx.save();
    ctx.translate(deco.underline.dx, deco.underline.dy);
    ctx.rotate(-rad); // level on the frame, as in Figma
    ctx.drawImage(
      line.source,
      -deco.underline.padX,
      -deco.underline.padY,
      length + 2 * deco.underline.padX,
      deco.underline.height,
    );
    ctx.restore();
  }
}

/** The polaroid date stamp: "'26 12 24" (Figma 836:1681), Asia/Seoul. */
export function formatStampLabel(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `'${get("year")} ${get("month")} ${get("day")}`;
}

/** "2026.12.24" in Asia/Seoul, independent of the kiosk's OS timezone. */
export function formatDateLabel(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")}`;
}
