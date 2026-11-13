import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";
import { lockupBox } from "./shared";

/**
 * STUDIO SHALOM · 2×2 (D77): four 4:3 photos in a grid on the booth backdrop, each on a paper
 * mat, the lockup (with the star in its O) below them. 600 × 750 (4:5), saved at 2× like every
 * frame. Figma: "SS 02 · 네컷 프레임" (file ZbeBrS0o5012SNFrGZNyIU), node "10 네컷 프레임 · 2×2".
 */
const SIZE = { width: 600, height: 750 } as const;
const COLORS = {
  backdrop: "#DDBDA1",
  paper: "#F6EEE4",
  ink: "#2B1A10",
} as const;

/** 28 px outer margin, a 6 px paper mat round each photo, 16 px between mats. */
const MARGIN = 28;
const MAT = 6;
const GAP = 16;
const PHOTO_W = (SIZE.width - 2 * MARGIN - 4 * MAT - GAP) / 2; // 252
const PHOTO_H = (PHOTO_W * 3) / 4; // 189 (4:3, preview = result)

const slots: FrameSlot[] = [0, 1, 2, 3].map((i) => ({
  x: MARGIN + MAT + (i % 2) * (PHOTO_W + 2 * MAT + GAP),
  y: MARGIN + MAT + Math.floor(i / 2) * (PHOTO_H + 2 * MAT + GAP),
  width: PHOTO_W,
  height: PHOTO_H,
}));

const lowest = Math.max(...slots.map((s) => s.y + s.height)) + MAT; // 446

export const shalomGrid: FrameDefinition = {
  id: "shalom-grid",
  name: "STUDIO SHALOM 2×2",
  label: "샬롬 2×2",
  labelEn: "Shalom 2×2",
  outputWidth: SIZE.width,
  outputHeight: SIZE.height,
  background: { type: "solid", color: COLORS.backdrop },
  slots,
  decorations: [
    ...slots.flatMap((s, slot) => [
      {
        type: "rect" as const,
        x: s.x - MAT,
        y: s.y - MAT,
        width: s.width + 2 * MAT,
        height: s.height + 2 * MAT,
        color: COLORS.paper,
      },
      { type: "photo" as const, slot },
    ]),
    {
      type: "image",
      src: "/frames/shalom-lockup.svg",
      ...lockupBox(lowest + 40, 104, SIZE.width),
      brand: { color: COLORS.ink, on: COLORS.backdrop },
    },
    {
      type: "text",
      text: "Christmas Village 2026 · {date}",
      x: SIZE.width / 2,
      y: 624,
      size: 16,
      weight: 500,
      color: COLORS.ink,
      align: "center",
      letterSpacing: 1,
    },
    {
      type: "text",
      text: "Blessed are the peacemakers,",
      x: SIZE.width / 2,
      y: 660,
      size: 16,
      weight: 400,
      color: COLORS.ink,
      align: "center",
    },
    {
      type: "text",
      text: "for they will be called children of God.",
      x: SIZE.width / 2,
      y: 685,
      size: 16,
      weight: 400,
      color: COLORS.ink,
      align: "center",
    },
    {
      type: "text",
      text: "MT 5:9",
      x: SIZE.width / 2,
      y: 721,
      size: 14,
      weight: 400,
      color: COLORS.ink,
      align: "center",
      letterSpacing: 2,
    },
  ],
};
