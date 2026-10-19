import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";

/**
 * Figma: 241:5597 (editable two-, three-, five-, and six-photo variants).
 * All sessions capture 6 photos, but each frame consumes exactly its own slot count.
 * A constant 2:6 strip aspect keeps mobile delivery and the existing wall predictable.
 */
function flexibleStrip(id: string, label: string, count: number, paper: boolean): FrameDefinition {
  const gap = 22;
  const available = 3225;
  const height = Math.min(810, Math.floor((available - (count - 1) * gap) / count));
  const width = Math.floor((height * 4) / 3);
  const stack = count * height + (count - 1) * gap;
  const top = Math.floor(150 + (available - stack) / 2);
  const slots: FrameSlot[] = Array.from({ length: count }, (_, i) => ({
    x: Math.floor((1200 - width) / 2),
    y: top + i * (height + gap),
    width,
    height,
    radius: paper ? 5 : 12,
    border: { color: paper ? "#7b624a" : "#e4b969", width: 3 },
  }));
  const ink = paper ? "#202632" : "#ffd89a";
  return {
    id,
    name: label,
    label,
    outputWidth: 1200,
    outputHeight: 3600,
    background: { type: "solid", color: paper ? "#f4eee2" : "#111b36" },
    slots,
    decorations: [
      {
        type: "text",
        text: "FOLLOW THE LIGHTS",
        x: 600,
        y: 3490,
        size: 64,
        weight: 700,
        color: ink,
        align: "center",
        letterSpacing: 10,
      },
      {
        type: "text",
        text: "Christmas Village 2026 · {date}",
        x: 600,
        y: 3555,
        size: 30,
        weight: 500,
        color: ink,
        align: "center",
      },
    ],
  };
}

export const twoStars = flexibleStrip("two-stars", "별빛 포스트카드 · 2컷", 2, true);
export const threeMoments = flexibleStrip("three-moments", "세 장의 이야기 · 3컷", 3, true);
export const fiveLights = flexibleStrip("five-lights", "별빛 다섯 장 · 5컷", 5, false);
export const sixLights = flexibleStrip("six-lights", "여섯 장의 밤 · 6컷", 6, false);
