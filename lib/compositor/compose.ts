import { FONT_STACK, get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import { coverCrop, seededRandom } from "./geometry";
import type {
  ComposeContext,
  ComposeImage,
  FrameBackground,
  FrameDecoration,
  FrameDefinition,
  FrameSlot,
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
  frame.slots.forEach((slot, i) => drawPhoto(ctx, slot, images[i]!));
  for (const deco of frame.decorations) drawDecoration(ctx, deco, context);

  ctx.restore();
  return canvas;
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

function drawPhoto(ctx: CanvasRenderingContext2D, slot: FrameSlot, image: ComposeImage) {
  const crop = coverCrop(image.width, image.height, slot.width / slot.height);
  ctx.save();
  roundedRectPath(ctx, slot.x, slot.y, slot.width, slot.height, slot.radius ?? 0);
  ctx.clip();
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
  ctx.restore();

  if (slot.border && slot.border.width > 0) {
    ctx.save();
    ctx.strokeStyle = slot.border.color;
    ctx.lineWidth = slot.border.width;
    roundedRectPath(ctx, slot.x, slot.y, slot.width, slot.height, slot.radius ?? 0);
    ctx.stroke();
    ctx.restore();
  }
}

function drawDecoration(
  ctx: CanvasRenderingContext2D,
  deco: FrameDecoration,
  context: ComposeContext,
) {
  ctx.save();
  switch (deco.type) {
    case "rect":
      ctx.fillStyle = deco.color;
      roundedRectPath(ctx, deco.x, deco.y, deco.width, deco.height, deco.radius ?? 0);
      ctx.fill();
      break;
    case "text": {
      ctx.fillStyle = deco.color;
      ctx.font = `${deco.weight ?? 500} ${deco.size}px ${FONT_STACK}`;
      ctx.textAlign = deco.align ?? "left";
      ctx.textBaseline = "alphabetic";
      if (deco.letterSpacing) {
        // Not in every canvas implementation; harmless where unsupported.
        (ctx as unknown as { letterSpacing: string }).letterSpacing = `${deco.letterSpacing}px`;
      }
      ctx.fillText(deco.text.replaceAll("{date}", context.dateLabel), deco.x, deco.y);
      break;
    }
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
