import type { FrameDecoration, FrameDefinition, FrameSlot } from "@/lib/compositor/types";
import { lockupBox } from "./shared";

/**
 * STUDIO SHALOM · 편지 세트 (D81): one frame per thing you would put in an envelope — a single
 * print, a postcard, a strip of film, a letter, a highlight sheet and a sheet of stamps. Each holds
 * a different number of photos (1–6), so every kiosk session of six shots can end in any of them.
 *
 * Only the brand tokens of app/globals.css are used, no gradients and no glow. Every photo slot is
 * 4:3 (preview = result), square-cornered, and the lockup always sits below the last photo.
 * Figma: "SS 02 · 네컷 프레임" (file ZbeBrS0o5012SNFrGZNyIU), section "편지 세트".
 */
export const SHALOM = {
  backdrop: "#DDBDA1",
  paper: "#F6EEE4",
  ink: "#2B1A10",
  button: "#412D1B",
  accent: "#7A440E",
} as const;

const INK_LOCKUP = "/frames/shalom-lockup.svg";
const PAPER_LOCKUP = "/frames/shalom-lockup-paper.svg";
const STAR = "/frames/shalom-star-ink.svg";
const SEAL = "/frames/wax-seal.webp";

/** A 4:3 slot `width` wide. */
function slot(x: number, y: number, width: number): FrameSlot {
  return { x, y, width, height: (width * 3) / 4 };
}

function text(
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  opts: {
    weight?: 400 | 500 | 600 | 700;
    align?: "left" | "center" | "right";
    spacing?: number;
  } = {},
): FrameDecoration {
  return {
    type: "text",
    text: value,
    x,
    y,
    size,
    color,
    weight: opts.weight ?? 500,
    align: opts.align ?? "center",
    letterSpacing: opts.spacing,
  };
}

function hairline(x: number, y: number, width: number, color: string, height = 1): FrameDecoration {
  return { type: "rect", x, y, width, height, color };
}

/** A paper mat `pad` px round a slot, then the photo on it. */
function matted(s: FrameSlot, slotIndex: number, pad: number, color: string): FrameDecoration[] {
  return [
    {
      type: "rect",
      x: s.x - pad,
      y: s.y - pad,
      width: s.width + 2 * pad,
      height: s.height + 2 * pad,
      color,
    },
    { type: "photo", slot: slotIndex },
  ];
}

/**
 * Stamp perforation: small discs of the background colour centred on the edges of a box, so
 * the paper looks torn from a sheet. Drawn as round rects (the compositor has no circle primitive).
 */
function perforation(
  box: { x: number; y: number; width: number; height: number },
  color: string,
  radius = 4,
  step = 14,
): FrameDecoration[] {
  const out: FrameDecoration[] = [];
  const dot = (cx: number, cy: number) =>
    out.push({
      type: "rect",
      x: cx - radius,
      y: cy - radius,
      width: radius * 2,
      height: radius * 2,
      radius,
      color,
    });
  const across = Math.max(1, Math.round(box.width / step));
  for (let i = 0; i <= across; i++) {
    const cx = box.x + (box.width * i) / across;
    dot(cx, box.y);
    dot(cx, box.y + box.height);
  }
  const down = Math.max(1, Math.round(box.height / step));
  for (let i = 1; i < down; i++) {
    const cy = box.y + (box.height * i) / down;
    dot(box.x, cy);
    dot(box.x + box.width, cy);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ── 1컷 · 한 장 — one print on paper, a magazine-style caption line under it ────────────────
const singleSlot = slot(40, 40, 520); // 520 × 390
export const shalomSingle: FrameDefinition = {
  id: "shalom-single",
  name: "STUDIO SHALOM · One",
  label: "한 장",
  labelEn: "One",
  outputWidth: 600,
  outputHeight: 750,
  background: { type: "solid", color: SHALOM.paper },
  slots: [singleSlot],
  decorations: [
    { type: "photo", slot: 0 },
    hairline(40, 452, 520, SHALOM.ink),
    text("CHRISTMAS VILLAGE 2026", 40, 478, 13, SHALOM.ink, {
      weight: 600,
      align: "left",
      spacing: 3,
    }),
    text("{date}", 560, 478, 13, SHALOM.ink, { weight: 600, align: "right", spacing: 2 }),
    {
      type: "image",
      src: INK_LOCKUP,
      ...lockupBox(526, 120, 600),
      brand: { color: SHALOM.ink, on: SHALOM.paper },
    },
    text("MT 5:9", 300, 700, 15, SHALOM.ink, { weight: 500, spacing: 4 }),
  ],
};

// ── 2컷 · 엽서 — a landscape postcard: two photos, the address side's stamp below ───────────
const POST = { width: 900, height: 600 } as const;
const postSlots = [slot(36, 36, 405), slot(459, 36, 405)]; // 405 × 303.75 each
const stamp = { x: 748, y: 384, width: 116, height: 140 };
export const shalomPostcard: FrameDefinition = {
  id: "shalom-postcard",
  name: "STUDIO SHALOM · Postcard",
  label: "엽서",
  labelEn: "Postcard",
  outputWidth: POST.width,
  outputHeight: POST.height,
  background: { type: "solid", color: SHALOM.paper },
  slots: postSlots,
  decorations: [
    { type: "photo", slot: 0 },
    { type: "photo", slot: 1 },
    text("POST CARD", 36, 408, 15, SHALOM.ink, { weight: 600, align: "left", spacing: 5 }),
    hairline(36, 424, 200, SHALOM.ink),
    text("Christmas Village 2026", 36, 452, 15, SHALOM.ink, { align: "left" }),
    text("{date}", 36, 477, 15, SHALOM.ink, { align: "left", spacing: 1 }),
    {
      type: "image",
      src: INK_LOCKUP,
      ...lockupBox(372, 128, POST.width),
      brand: { color: SHALOM.ink, on: SHALOM.paper },
    },
    { type: "rect", ...stamp, color: SHALOM.backdrop },
    ...perforation(stamp, SHALOM.paper),
    { type: "image", src: STAR, x: stamp.x + 42.66, y: stamp.y + 30, width: 30.68, height: 48.7 },
    text("MT 5:9", stamp.x + stamp.width / 2, stamp.y + 112, 15, SHALOM.ink, {
      weight: 600,
      spacing: 2,
    }),
  ],
};

// ── 3컷 · 필름 — a strip of brown film base, sprocket holes and edge numbers ───────────────
const FILM = { width: 600, height: 1500 } as const;
const filmSlots = [0, 1, 2].map((i) => slot(70, 70 + i * 385, 460)); // 460 × 345, 40 px apart
const sprockets: FrameDecoration[] = [];
for (let y = 28; y + 28 <= FILM.height - 20; y += 56)
  for (const x of [22, FILM.width - 22 - 20])
    sprockets.push({
      type: "rect",
      x,
      y,
      width: 20,
      height: 28,
      radius: 4,
      color: SHALOM.backdrop,
    });
export const shalomFilm: FrameDefinition = {
  id: "shalom-film",
  name: "STUDIO SHALOM · Film",
  label: "필름",
  labelEn: "Film",
  outputWidth: FILM.width,
  outputHeight: FILM.height,
  background: { type: "solid", color: SHALOM.ink },
  slots: filmSlots,
  decorations: [
    ...sprockets,
    ...filmSlots.flatMap((s, i): FrameDecoration[] => [
      { type: "photo", slot: i },
      text(`${pad2(i + 1)}`, s.x, s.y + s.height + 26, 13, SHALOM.backdrop, {
        weight: 600,
        align: "left",
        spacing: 2,
      }),
      text("SHALOM 2026", s.x + s.width, s.y + s.height + 26, 13, SHALOM.backdrop, {
        weight: 600,
        align: "right",
        spacing: 3,
      }),
    ]),
    {
      type: "image",
      src: PAPER_LOCKUP,
      ...lockupBox(1262, 120, FILM.width),
      brand: { color: SHALOM.paper, on: SHALOM.ink },
    },
    text("Christmas Village 2026 · {date}", 300, 1440, 15, SHALOM.backdrop, { spacing: 1 }),
  ],
};

// ── 4컷 · 편지 — four photos down a letter, a thin inset border, the wax seal at the foot ─
const LETTER = { width: 600, height: 1800 } as const;
const letterSlots = [0, 1, 2, 3].map((i) => slot(70, 70 + i * 373, 460)); // 460 × 345, 28 apart
const INSET = 26;
export const shalomLetter: FrameDefinition = {
  id: "shalom-letter",
  name: "STUDIO SHALOM · Letter",
  label: "편지",
  labelEn: "Letter",
  outputWidth: LETTER.width,
  outputHeight: LETTER.height,
  background: { type: "solid", color: SHALOM.paper },
  slots: letterSlots,
  decorations: [
    hairline(INSET, INSET, LETTER.width - 2 * INSET, SHALOM.accent, 1.5),
    hairline(INSET, LETTER.height - INSET - 1.5, LETTER.width - 2 * INSET, SHALOM.accent, 1.5),
    {
      type: "rect",
      x: INSET,
      y: INSET,
      width: 1.5,
      height: LETTER.height - 2 * INSET,
      color: SHALOM.accent,
    },
    {
      type: "rect",
      x: LETTER.width - INSET - 1.5,
      y: INSET,
      width: 1.5,
      height: LETTER.height - 2 * INSET,
      color: SHALOM.accent,
    },
    ...letterSlots.map((_, i): FrameDecoration => ({ type: "photo", slot: i })),
    {
      type: "image",
      src: INK_LOCKUP,
      ...lockupBox(1572, 112, LETTER.width),
      brand: { color: SHALOM.ink, on: SHALOM.paper },
    },
    text("Christmas Village 2026 · {date}", 300, 1730, 15, SHALOM.ink, { spacing: 1 }),
    text("MT 5:9", 300, 1756, 13, SHALOM.ink, { weight: 600, spacing: 4 }),
    // Decoration only: below every photo and clear of the lockup and the caption.
    { type: "image", src: SEAL, x: 462, y: 1618, width: 96, height: 96 },
  ],
};

// ── 5컷 · 하이라이트 — one large photo over four small ones, on paper mats ─────────────────
const HL = { width: 600, height: 1050 } as const;
const M = 28;
const MAT = 6;
const heroSlot = slot(M + MAT, M + MAT, HL.width - 2 * (M + MAT)); // 532 × 399
const smallW = (HL.width - 2 * M - 16) / 2 - 2 * MAT; // 252 × 189
const smallTop = heroSlot.y + heroSlot.height + MAT + 16 + MAT;
const smallSlots = [0, 1, 2, 3].map((i) =>
  slot(
    M + MAT + (i % 2) * (smallW + 2 * MAT + 16),
    smallTop + Math.floor(i / 2) * ((smallW * 3) / 4 + 2 * MAT + 16),
    smallW,
  ),
);
const hlSlots = [heroSlot, ...smallSlots];
export const shalomHighlight: FrameDefinition = {
  id: "shalom-highlight",
  name: "STUDIO SHALOM · Highlight",
  label: "하이라이트",
  labelEn: "Highlight",
  outputWidth: HL.width,
  outputHeight: HL.height,
  background: { type: "solid", color: SHALOM.backdrop },
  slots: hlSlots,
  decorations: [
    ...hlSlots.flatMap((s, i) => matted(s, i, MAT, SHALOM.paper)),
    {
      type: "image",
      src: INK_LOCKUP,
      ...lockupBox(904, 92, HL.width),
      brand: { color: SHALOM.ink, on: SHALOM.backdrop },
    },
    text("Christmas Village 2026 · {date}", 300, 1026, 13, SHALOM.ink, { weight: 600, spacing: 2 }),
  ],
};

// ── 6컷 · 우표 — a sheet of six perforated stamps, numbered like a series ──────────────────
const ST = { width: 600, height: 960 } as const;
const STAMP_W = 252;
const STAMP_PAD = 12;
const STAMP_FOOT = 30;
const stampPhotoW = STAMP_W - 2 * STAMP_PAD; // 228 × 171
const STAMP_H = STAMP_PAD + (stampPhotoW * 3) / 4 + STAMP_FOOT; // 213
const stamps = [0, 1, 2, 3, 4, 5].map((i) => ({
  x: 36 + (i % 2) * (STAMP_W + 24),
  y: 36 + Math.floor(i / 2) * (STAMP_H + 24),
  width: STAMP_W,
  height: STAMP_H,
}));
const stampSlots = stamps.map((b) => slot(b.x + STAMP_PAD, b.y + STAMP_PAD, stampPhotoW));
export const shalomStamps: FrameDefinition = {
  id: "shalom-stamps",
  name: "STUDIO SHALOM · Stamps",
  label: "우표",
  labelEn: "Stamps",
  outputWidth: ST.width,
  outputHeight: ST.height,
  background: { type: "solid", color: SHALOM.backdrop },
  slots: stampSlots,
  decorations: [
    ...stamps.flatMap((b, i): FrameDecoration[] => [
      { type: "rect", ...b, color: SHALOM.paper },
      ...perforation(b, SHALOM.backdrop),
      { type: "photo", slot: i },
      text(`No.${pad2(i + 1)}`, b.x + STAMP_PAD, b.y + b.height - 10, 13, SHALOM.ink, {
        weight: 600,
        align: "left",
        spacing: 1,
      }),
      text("SHALOM", b.x + b.width - STAMP_PAD, b.y + b.height - 10, 13, SHALOM.ink, {
        weight: 600,
        align: "right",
        spacing: 3,
      }),
    ]),
    {
      type: "image",
      src: INK_LOCKUP,
      ...lockupBox(776, 104, ST.width),
      brand: { color: SHALOM.ink, on: SHALOM.backdrop },
    },
    text("Christmas Village 2026 · {date}", 300, 924, 13, SHALOM.ink, { weight: 600, spacing: 2 }),
  ],
};
