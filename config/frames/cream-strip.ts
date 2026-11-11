import type { FrameDefinition } from "@/lib/compositor/types";
import { lockupBox, stripSlots, STRIP } from "./shared";

// Template D · Cream Strip — 마태복음 2:9-10, 별을 따라가는 빛의 길. 가장 밝고 단정한 안.
export const creamStrip: FrameDefinition = {
  id: "cream-strip",
  name: "Cream Strip",
  label: "크림",
  outputWidth: STRIP.width,
  outputHeight: STRIP.height,
  background: { type: "solid", color: "#fff7e6" },
  slots: stripSlots(304 / 3),
  decorations: [
    { type: "image", src: "/frames/cream-light-trail.svg", x: 0, y: 0, width: 600, height: 1800 },
    { type: "photo", slot: 0 },
    { type: "photo", slot: 1 },
    { type: "photo", slot: 2 },
    { type: "photo", slot: 3 },
    { type: "image", src: "/frames/cream-sparkle.svg", x: 272, y: 1518, width: 56, height: 56 },
    {
      type: "image",
      src: "/frames/cream-lockup.svg",
      ...lockupBox(1583, 86),
      brand: { color: "#0b1026", on: "#fff7e6" },
    },
    {
      type: "text",
      text: "별빛을 따라 오신 걸 환영해요",
      x: 300,
      y: 1696,
      size: 20,
      weight: 400,
      color: "#4b5068",
      align: "center",
    },
    {
      type: "image",
      src: "/frames/cream-christmas-2026.svg",
      x: 230.177,
      y: 1737.19,
      width: 158,
      height: 17,
    },
  ],
};
