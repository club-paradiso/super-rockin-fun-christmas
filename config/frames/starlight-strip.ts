import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";

// Classic 2×6 in four-cut strip at 600 dpi: 1200 × 3600. Slots are 4:3.
const slots: FrameSlot[] = [0, 1, 2, 3].map((i) => ({
  x: 60,
  y: 60 + i * (810 + 30),
  width: 1080,
  height: 810,
  radius: 12,
}));

export const starlightStrip: FrameDefinition = {
  id: "starlight-strip",
  name: "Starlight Strip",
  label: "별빛 네컷",
  outputWidth: 1200,
  outputHeight: 3600,
  background: {
    type: "vertical",
    stops: [
      { offset: 0, color: "#0c1326" },
      { offset: 1, color: "#16203a" },
    ],
  },
  slots,
  decorations: [
    {
      type: "stars",
      seed: 2026,
      count: 46,
      area: { x: 30, y: 3400, width: 1140, height: 190 },
      color: "#f6e7c8",
      minRadius: 1.5,
      maxRadius: 4,
    },
    {
      type: "text",
      text: "FOLLOW THE LIGHTS",
      x: 600,
      y: 3488,
      size: 64,
      weight: 700,
      color: "#ffd89a",
      align: "center",
      letterSpacing: 10,
    },
    {
      type: "text",
      text: "Christmas Village 2026 · {date}",
      x: 600,
      y: 3556,
      size: 34,
      weight: 500,
      color: "#c9cfdf",
      align: "center",
      letterSpacing: 2,
    },
  ],
};
