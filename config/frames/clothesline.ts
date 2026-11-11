import type { FrameDecoration, FrameDefinition, FrameSlot } from "@/lib/compositor/types";
import { lockupBox, STRIP } from "./shared";

// Template C · Clothesline — 크라프트 종이 + 폴라로이드 + 집게. 미디어월 빨랫줄과 같은 언어.

/** Each polaroid's centre and tilt, from the Figma groups (bounding box centre, rotate). */
const POLAROIDS = [
  { cx: 43.68 + 497.282 / 2, cy: 51.02 + 408.241 / 2, deg: 2.2 },
  { cx: 58.66 + 493.368 / 2, cy: 405.78 + 403.325 / 2, deg: -1.6 },
  { cx: 50.49 + 490.728 / 2, cy: 790.56 + 400.023 / 2, deg: 1.2 },
  { cx: 58.65 + 495.983 / 2, cy: 1142.22 + 406.607 / 2, deg: -2 },
] as const;
const CARD = { width: 1448 / 3, height: 390, inset: 8 } as const;

const slots: FrameSlot[] = POLAROIDS.map(({ cx, cy, deg }) => ({
  x: cx - CARD.width / 2 + CARD.inset,
  y: cy - CARD.height / 2 + CARD.inset,
  width: 1400 / 3,
  height: 350,
  // The photo turns with its card, around the card's centre.
  rotation: { deg, pivot: { x: cx, y: cy } },
}));

/** Line, card, photo, pin — and the next line crosses the bottom of the card above it. */
const rows: FrameDecoration[] = POLAROIDS.flatMap(({ cx, cy, deg }, i): FrameDecoration[] => [
  { type: "rect", x: 0, y: 42 + 370 * i, width: 600, height: 3, color: "#a9774a" },
  {
    type: "rect",
    x: cx - CARD.width / 2,
    y: cy - CARD.height / 2,
    width: CARD.width,
    height: CARD.height,
    radius: 4,
    color: "#ffffff",
    rotation: { deg },
    shadow: { color: "rgba(51, 38, 26, 0.18)", blur: 14, offsetY: 6 },
  },
  { type: "photo", slot: i },
  {
    type: "image",
    src: "/frames/clothespin.svg",
    x: 288,
    y: 16 + 370 * i,
    width: 24,
    height: 74,
  },
]);

export const clothesline: FrameDefinition = {
  id: "clothesline",
  name: "Clothesline",
  label: "빨랫줄",
  outputWidth: STRIP.width,
  outputHeight: STRIP.height,
  background: { type: "solid", color: "#f7f1e3" },
  slots,
  decorations: [
    ...rows,
    {
      type: "image",
      src: "/frames/cream-lockup.svg",
      ...lockupBox(1563, 86),
      brand: { color: "#0b1026", on: "#f7f1e3" },
    },
    {
      type: "image",
      src: "/frames/clothesline-christmas-2026.svg",
      x: 225.73,
      y: 1661.94,
      width: 165,
      height: 17,
    },
    {
      type: "image",
      src: "/frames/clothesline-sparkle.svg",
      x: 287,
      y: 1715,
      width: 26,
      height: 26,
    },
  ],
};
