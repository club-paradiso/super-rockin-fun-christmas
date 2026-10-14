import type { FrameDecoration, FrameDefinition } from "@/lib/compositor/types";
import { sparkles, stripSlots, STRIP } from "./shared";

// Template B · Wood Window — 제주 한림의 밤 11시 창문. 나무 창틀 + 크림색 액자.
const mats: FrameDecoration[] = [0, 1, 2, 3].map((i) => ({
  type: "rect",
  x: 164 / 3,
  y: 44 + 370 * i,
  width: 1472 / 3,
  height: 374,
  radius: 8,
  color: "#f7f1e3",
}));

export const woodWindow: FrameDefinition = {
  id: "wood-window",
  name: "Wood Window",
  label: "창틀",
  outputWidth: STRIP.width,
  outputHeight: STRIP.height,
  background: { type: "solid", color: "#a9774a" },
  slots: stripSlots(200 / 3),
  decorations: [
    {
      type: "rect",
      x: 18,
      y: 18,
      width: 564,
      height: 1764,
      radius: 10,
      color: "#1c2756",
      stops: [
        { offset: 0, color: "#0b1026" },
        { offset: 0.75, color: "#1c2756" },
        { offset: 1, color: "#33417f" },
      ],
    },
    ...sparkles(
      "/frames/wood-sparkle.svg",
      [
        [24.87, 915.01, 5.53],
        [289.14, 1013.91, 10.19],
        [151.18, 562.04, 11.17],
        [291.22, 28.29, 5.83],
        [524.29, 54.25, 9.46],
        [552.62, 840.09, 6.32],
        [145.44, 325.52, 6.86],
        [444.59, 1036.26, 5.37],
        [41.79, 183.01, 8.49],
        [399.63, 1313.6, 5.92],
        [489.84, 1452.37, 11.18],
        [251.28, 381.34, 10.35],
        [239.41, 361.76, 11.18],
        [326.18, 529.65, 11.21],
        [205.53, 1068.18, 10.14],
        [194.07, 1446.65, 6.39],
        [497.23, 1346.91, 9.43],
        [97.45, 740.56, 9.52],
      ],
      1124,
    ),
    ...mats.flatMap((mat, i): FrameDecoration[] => [mat, { type: "photo", slot: i }]),
    { type: "rect", x: 0, y: 1520, width: 600, height: 26, color: "#c9a27a" },
    {
      type: "image",
      src: "/frames/wood-place.svg",
      x: 203.22,
      y: 1573.2,
      width: 157,
      height: 38,
    },
    {
      type: "image",
      src: "/frames/wood-lockup.svg",
      x: 90.5,
      y: 1630,
      width: 418,
      height: 69,
      brand: { color: "#f2c14e", on: "#33417f" },
    },
  ],
};
