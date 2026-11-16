import { BRAND_FONT, get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";

/**
 * The stamp ticket as a picture (1080 × 1920, an Instagram story), so a guest can keep it next to
 * the photo. Drawn from data only: the brand lockup is the outlined SVG the frames use
 * (public/frames/shalom-lockup.svg), the ring is public/studio/stamp-mark.png. Either may be
 * missing; the ticket is then drawn without the picture (rings drawn as lines, no lockup).
 *
 * Colours are the brand tokens (app/globals.css). One light from the top left (D-light): every
 * shadow falls to the bottom right.
 */
export const TICKET_SIZE = { width: 1080, height: 1920 } as const;

export const TICKET_COLORS = {
  backdrop: "#ddbda1",
  paper: "#f6eee4",
  ink: "#2b1a10",
  accent: "#7a440e",
} as const;

/** The shadow of something lying on the desk under a top-left light. */
export const LIGHT = { x: 14, y: 20, blur: 34, color: "rgba(43, 26, 16, 0.32)" } as const;

export interface TicketText {
  /** "2026.12.24" (formatDateLabel). */
  date: string;
  /** "오늘 12번째 기록", or "오늘의 기록" when the number is unknown. */
  record: string;
  /** "Christmas Village 2026". */
  event: string;
}

export interface TicketPictures {
  lockup?: CanvasImageSource | null;
  stamp?: CanvasImageSource | null;
}

/** Box of the paper ticket inside the picture. */
const PAPER = { x: 150, y: 260, w: 780, h: 1380, tooth: 18 } as const;
const STAMP = { cx: 540, cy: 720, size: 600, tilt: (-6 * Math.PI) / 180 } as const;

export function drawStampTicket(
  createCanvas: CanvasFactory,
  text: TicketText,
  pictures: TicketPictures = {},
): CanvasLike {
  const canvas = createCanvas(TICKET_SIZE.width, TICKET_SIZE.height);
  const ctx = get2d(canvas);
  const C = TICKET_COLORS;

  ctx.fillStyle = C.backdrop;
  ctx.fillRect(0, 0, TICKET_SIZE.width, TICKET_SIZE.height);

  // The paper ticket with torn (zig-zag) ends, and its shadow on the desk.
  ctx.save();
  ctx.shadowColor = LIGHT.color;
  ctx.shadowOffsetX = LIGHT.x;
  ctx.shadowOffsetY = LIGHT.y;
  ctx.shadowBlur = LIGHT.blur;
  ctx.fillStyle = C.paper;
  ticketPath(ctx);
  ctx.fill();
  ctx.restore();

  // The stamp: ring + brand mark, pressed slightly crooked like a hand stamp.
  ctx.save();
  ctx.translate(STAMP.cx, STAMP.cy);
  ctx.rotate(STAMP.tilt);
  const half = STAMP.size / 2;
  if (pictures.stamp) {
    ctx.drawImage(pictures.stamp, -half, -half, STAMP.size, STAMP.size);
  } else {
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(0, 0, half - 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, half - 44, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (pictures.lockup) {
    // public/frames/shalom-lockup.svg is 422 × 156.13.
    const w = 400;
    const h = (w * 156.13) / 422;
    ctx.drawImage(pictures.lockup, -w / 2, -h / 2, w, h);
  } else {
    ctx.fillStyle = C.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 64px "Cormorant Garamond", "Times New Roman", serif`;
    ctx.fillText("STUDIO SHALOM", 0, 0);
  }
  ctx.restore();

  // Date, the record number, the event.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.ink;
  ctx.globalAlpha = 0.75;
  ctx.font = `500 44px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(text.date, 540, 1150);
  ctx.globalAlpha = 1;
  ctx.font = `800 78px "${BRAND_FONT}", "Apple SD Gothic Neo", sans-serif`;
  ctx.fillText(text.record, 540, 1268);

  // A perforation, then the stub.
  ctx.strokeStyle = C.ink;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 12]);
  ctx.beginPath();
  ctx.moveTo(PAPER.x + 40, 1380);
  ctx.lineTo(PAPER.x + PAPER.w - 40, 1380);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.accent;
  ctx.font = `600 46px "Cormorant Garamond", "Times New Roman", serif`;
  ctx.fillText(text.event, 540, 1500);
  return canvas;
}

function ticketPath(ctx: CanvasRenderingContext2D) {
  const { x, y, w, h, tooth } = PAPER;
  const teeth = Math.round(w / (tooth * 2));
  const step = w / teeth;
  ctx.beginPath();
  ctx.moveTo(x, y + tooth);
  for (let i = 0; i < teeth; i++) {
    ctx.lineTo(x + step * i + step / 2, y);
    ctx.lineTo(x + step * (i + 1), y + tooth);
  }
  ctx.lineTo(x + w, y + h - tooth);
  for (let i = teeth; i > 0; i--) {
    ctx.lineTo(x + step * i - step / 2, y + h);
    ctx.lineTo(x + step * (i - 1), y + h - tooth);
  }
  ctx.closePath();
}

/** The font requests the ticket text needs (canvas does not wait for web fonts). */
export function ticketFontRequests(text: TicketText): { spec: string; text: string }[] {
  return [
    { spec: `800 78px "${BRAND_FONT}"`, text: text.record },
    { spec: `600 46px "Cormorant Garamond"`, text: text.event + "STUDIO SHALOM" },
  ];
}

/** "studio-shalom-2026-12-24-12.png" (no personal data in the name). */
export function ticketFileName(date: string, ordinal: number | null): string {
  const day = date.replaceAll(".", "-");
  return `studio-shalom-${day}${ordinal ? `-${ordinal}` : ""}.png`;
}
