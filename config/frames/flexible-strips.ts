import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";

/** Additional 2/3/5/6-slot designs, kept at the current 600×1800 Figma canvas size. */
function flexibleStrip(id: string, label: string, count: number, paper: boolean): FrameDefinition {
  const gap = 13;
  const height = Math.min(340, (1440 - (count - 1) * gap) / count);
  const width = height * (4 / 3);
  const startY = 65 + (1440 - (count * height + (count - 1) * gap)) / 2;
  const slots: FrameSlot[] = Array.from({ length: count }, (_, i) => ({
    x: (600 - width) / 2,
    y: startY + i * (height + gap),
    width,
    height,
    radius: 0,
  }));
  const ink = paper ? "#121a3d" : "#f2c14e";
  const on = paper ? "#f7f1e3" : "#070a1c";
  return {
    id, name: label, label, outputWidth: 600, outputHeight: 1800,
    background: { type: "solid", color: paper ? "#f7f1e3" : "#070a1c" },
    slots,
    decorations: [
      ...slots.map((_, slot) => ({ type: "photo" as const, slot })),
      { type: "rect", x: 248, y: 1555, width: 104, height: 2, color: ink },
      { type: "image", src: paper ? "/frames/cream-lockup.svg" : "/frames/navy-lockup.svg",
        x: 90, y: 1600, width: 420, height: 69, brand: { color: ink, on } },
      { type: "text", text: "Christmas Village 2026 · {date}", x: 300, y: 1720,
        size: 16, color: ink, align: "center" },
    ],
  };
}
export const twoStars = flexibleStrip("two-stars", "별빛 포스트카드 · 2컷", 2, true);
export const threeMoments = flexibleStrip("three-moments", "세 장의 이야기 · 3컷", 3, true);
export const fiveLights = flexibleStrip("five-lights", "별빛 다섯 장 · 5컷", 5, false);
export const sixLights = flexibleStrip("six-lights", "여섯 장의 밤 · 6컷", 6, false);
