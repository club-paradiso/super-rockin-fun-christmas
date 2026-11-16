import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";
import { lockupBox } from "./shared";

/**
 * Two frames the owner picked from the reference set and confirmed (D99). Their art is raster
 * (a gingham tablecloth, pixel windows), so each is one full-size overlay exported from Figma at
 * 2× with the photo holes cut out: the background colour, then the photos, then the overlay, then
 * the lockup. Every photo is 4:3 (preview = result) and the lockup sits below the last photo.
 * Figma: "SS 02 · 네컷 프레임" (file ZbeBrS0o5012SNFrGZNyIU), section "✅ 네컷 프레임 확정본".
 */
const BRAND = { backdrop: "#DDBDA1", paper: "#F6EEE4", ink: "#2B1A10" } as const;
const LOCKUP = "/frames/shalom-lockup.svg";

function layers(slots: FrameSlot[], overlay: string, width: number, height: number) {
  return [
    ...slots.map((_, slot) => ({ type: "photo" as const, slot })),
    { type: "image" as const, src: overlay, x: 0, y: 0, width, height },
  ];
}

// ── 체크 식탁 · 3컷 — a gingham tablecloth with plates, each photo on a paper mat ──────────────
const GINGHAM = { width: 440, height: 1280 } as const;
const ginghamSlots: FrameSlot[] = [
  { x: 46, y: 89, width: 324, height: 243 },
  { x: 47, y: 477, width: 328, height: 246 },
  { x: 52, y: 853, width: 340, height: 255 },
];
export const ginghamPlates: FrameDefinition = {
  id: "gingham-plates",
  name: "Gingham Plates",
  label: "체크 식탁",
  labelEn: "Gingham",
  labelZh: "格子餐桌",
  outputWidth: GINGHAM.width,
  outputHeight: GINGHAM.height,
  // Shows through the photo holes as the paper mat round each photo.
  background: { type: "solid", color: BRAND.paper },
  slots: ginghamSlots,
  decorations: [
    ...layers(ginghamSlots, "/frames/gingham-plates.webp", GINGHAM.width, GINGHAM.height),
    {
      type: "image",
      src: LOCKUP,
      ...lockupBox(1184, 84, GINGHAM.width),
      brand: { color: BRAND.ink, on: BRAND.backdrop },
    },
  ],
};

// ── 픽셀 창 · 4컷 — four pixel-art windows in two staggered columns ──────────────────────────
const PIXEL = { width: 720, height: 1280 } as const;
const pixelSlots: FrameSlot[] = [
  { x: 43, y: 129, width: 300, height: 225 },
  { x: 377, y: 183, width: 300, height: 225 },
  { x: 43, y: 424, width: 300, height: 225 },
  { x: 377, y: 478, width: 300, height: 225 },
];
export const pixelWindows: FrameDefinition = {
  id: "pixel-windows",
  name: "Pixel Windows",
  label: "픽셀 창",
  labelEn: "Pixel windows",
  labelZh: "像素窗口",
  outputWidth: PIXEL.width,
  outputHeight: PIXEL.height,
  background: { type: "solid", color: BRAND.backdrop },
  slots: pixelSlots,
  decorations: [
    ...layers(pixelSlots, "/frames/pixel-windows.webp", PIXEL.width, PIXEL.height),
    {
      type: "image",
      src: LOCKUP,
      ...lockupBox(822, 120, PIXEL.width),
      brand: { color: BRAND.ink, on: BRAND.backdrop },
    },
  ],
};
