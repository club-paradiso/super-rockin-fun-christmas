import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";

// Square 2×2 "window" — four panes of one lit house window. Phone-friendly 1600 × 1600.
const panes: [number, number][] = [
  [70, 130],
  [830, 130],
  [70, 715],
  [830, 715],
];
const slots: FrameSlot[] = panes.map(([x, y]) => ({
  x,
  y,
  width: 700,
  height: 525,
  radius: 8,
  border: { color: "#e9c27d", width: 6 },
}));

export const villageWindow: FrameDefinition = {
  id: "village-window",
  name: "Village Window",
  label: "마을 창문",
  outputWidth: 1600,
  outputHeight: 1600,
  background: { type: "solid", color: "#111a2e" },
  slots,
  decorations: [
    {
      type: "lights",
      from: { x: 90, y: 64 },
      to: { x: 1510, y: 64 },
      count: 18,
      radius: 10,
      colors: ["#ffd27f", "#ffe9bf", "#f3a65a"],
      wire: "#2b3550",
    },
    {
      type: "stars",
      seed: 1225,
      count: 60,
      area: { x: 40, y: 1270, width: 1520, height: 300 },
      color: "#f6e7c8",
      minRadius: 1.5,
      maxRadius: 3.5,
    },
    {
      type: "text",
      text: "FOLLOW THE LIGHTS",
      x: 800,
      y: 1410,
      size: 72,
      weight: 700,
      color: "#ffd89a",
      align: "center",
      letterSpacing: 12,
    },
    {
      type: "text",
      text: "한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다",
      x: 800,
      y: 1478,
      size: 32,
      weight: 500,
      color: "#d7dbe6",
      align: "center",
    },
    {
      type: "text",
      text: "Christmas Village 2026 · {date}",
      x: 800,
      y: 1532,
      size: 28,
      weight: 500,
      color: "#9aa3b8",
      align: "center",
      letterSpacing: 2,
    },
  ],
};
