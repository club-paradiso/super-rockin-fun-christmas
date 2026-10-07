import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";

// Same strip geometry as starlight-strip on warm paper, with thin ink borders.
const slots: FrameSlot[] = [0, 1, 2, 3].map((i) => ({
  x: 60,
  y: 60 + i * (810 + 30),
  width: 1080,
  height: 810,
  radius: 4,
  border: { color: "#2a2620", width: 4 },
}));

export const snowPaperStrip: FrameDefinition = {
  id: "snow-paper-strip",
  name: "Snow Paper Strip",
  label: "눈 종이 네컷",
  outputWidth: 1200,
  outputHeight: 3600,
  background: { type: "solid", color: "#f4eee2" },
  slots,
  decorations: [
    {
      type: "lights",
      from: { x: 80, y: 3432 },
      to: { x: 1120, y: 3432 },
      count: 14,
      radius: 9,
      colors: ["#d9563f", "#e8b04a", "#4d8a6a", "#e8b04a"],
      wire: "#3b352c",
    },
    {
      type: "text",
      text: "FOLLOW THE LIGHTS",
      x: 600,
      y: 3516,
      size: 56,
      weight: 800,
      color: "#2a2620",
      align: "center",
      letterSpacing: 8,
    },
    {
      type: "text",
      text: "{date} · Christmas Village",
      x: 600,
      y: 3568,
      size: 30,
      weight: 500,
      color: "#6b6152",
      align: "center",
      letterSpacing: 2,
    },
  ],
};
