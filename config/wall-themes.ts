import { WALL_CONFIG } from "./wall";
import { ROTATE_MINUTES, type WallClip, type WallLook, type WallTheme } from "@/lib/wall/themes";

/**
 * The media-wall themes (D85). Every `current` theme is a background from Figma
 * `SS 03 · 미디어월 시안 — The Wall of Peace` (file ZbeBrS0o5012SNFrGZNyIU), cut to the wall
 * canvas by scripts/wall-backgrounds.mjs. All numbers are measured in that 3840 × 1080 picture:
 *
 * - `line`: the curve photos hang from, y = y0 − curve · (x − midX)² (lowest in the middle). For
 *   a rope that is in the picture it follows the rope; for pegs in the picture it follows the
 *   point just under each peg; where the picture has no line, the app draws one (`rope`).
 * - `slots`: where photos hang. They keep clear of what the picture is about (the chapel, the
 *   manger, the setting sun, the cross) and of the lantern and candles at the sides.
 * - `strip`: the box of a 1:3 four-cut. Its bottom stays above the ledge / window sill.
 *
 * tests/unit/wall-themes.test.ts checks every theme: photos inside the picture, neighbours never
 * touching (strips, 2×2 and phone cards), the wordmark clear of every photo.
 *
 * The originals are about 2048 px wide (enlarged 1.9× here). A sharper original from the designer
 * replaces the file without touching these numbers, as long as the composition is the same.
 */
const CANVAS = { width: 3840, height: 1080 } as const;
/**
 * The wooden clothespin (the user's own picture, 2026-11): 323 × 1975 cut to 105 × 640 WebP.
 * Drawn 23 × 140. The photo's weight pulls it down, so the line rests at the top of its notch
 * (78.5 % down) and the jaw ends 30 px below the line, over the strip top.
 */
const PEG: WallClip = {
  kind: "clip",
  image: "/wall/peg-wood.webp",
  width: 23,
  height: 140,
  centerX: 11.5,
  lineY: 110,
};
/**
 * The old brass clip, where it has always been drawn: 37 × 70, a 22.4 × 56 clip at (7, 2.8) whose
 * top is 26 px above the line, so it reaches 10 px over the strip top.
 */
const BRASS: WallClip = {
  kind: "clip",
  image: WALL_CONFIG.scene.clip,
  width: 37,
  height: 70,
  centerX: 18.2,
  lineY: 28.8,
};
const TWINE = "#B48F5E";
const FIGMA = "Figma SS 03";

export const WALL_THEMES: readonly WallTheme[] = [
  {
    id: "peace-wall",
    name: "평화의 벽 · 십자가 · 겨울 햇살",
    note: "햇살 드는 회벽에 빨랫줄 하나. 사진이 가장 또렷하게 보이는 장면",
    source: `${FIGMA} · S03 (354:28)`,
    status: "current",
    background: "/wall/themes/peace-wall.jpg",
    preview: "/wall/themes/peace-wall.preview.jpg",
    fallbackColor: "#E9C79B",
    tone: "light",
    scene: {
      ...CANVAS,
      line: { midX: 1840, y0: 302, curve: 4.32e-5 },
      strip: { width: 200, height: 600, drop: 20 },
      slots: [
        { x: 760, tilt: -0.9 },
        { x: 1320, tilt: 0.6 },
        { x: 1880, tilt: -0.4 },
        { x: 2440, tilt: 0.8 },
        { x: 3000, tilt: -0.7 },
      ],
    },
    liteSlots: [0, 1, 3, 4],
    hang: PEG,
    rope: null,
    wideMax: 440,
    wordmark: { x: 1960, y: 84, size: 64, tone: "ink" },
    emptyTextY: 620,
    motion: "none",
  },
  {
    id: "snowy-chapel",
    name: "눈 덮인 예배당 · 기억의 빨랫줄",
    note: "눈 내린 숲과 작은 예배당. 예배당은 사진에 가리지 않아요",
    source: `${FIGMA} · S01 (354:20)`,
    status: "current",
    background: "/wall/themes/snowy-chapel.jpg",
    preview: "/wall/themes/snowy-chapel.preview.jpg",
    fallbackColor: "#E2B79C",
    tone: "light",
    scene: {
      ...CANVAS,
      line: { midX: 1910, y0: 262, curve: 3.4e-5 },
      strip: { width: 200, height: 600, drop: 20 },
      slots: [
        { x: 690, tilt: -0.8 },
        { x: 1160, tilt: 0.7 },
        { x: 1630, tilt: -0.5 },
        { x: 2100, tilt: 0.6 },
        { x: 2570, tilt: -0.6 },
      ],
    },
    liteSlots: [0, 1, 3, 4],
    hang: PEG,
    rope: null,
    wideMax: 380,
    wordmark: { x: 1960, y: 64, size: 60, tone: "ink" },
    emptyTextY: 600,
    motion: "none",
  },
  {
    id: "star-of-peace",
    name: "성탄의 별 · 설경 · 기억의 빨랫줄",
    note: "설산 위 성탄의 별. 그림 속 집게에 사진이 걸려요",
    source: `${FIGMA} · S02 (354:24)`,
    status: "current",
    background: "/wall/themes/star-of-peace.jpg",
    preview: "/wall/themes/star-of-peace.preview.jpg",
    fallbackColor: "#CDB3B4",
    tone: "light",
    scene: {
      ...CANVAS,
      line: { midX: 1900, y0: 368, curve: 2.52e-5 },
      strip: { width: 170, height: 510, drop: 0 },
      slots: [
        { x: 706, tilt: -0.5 },
        { x: 1402, tilt: 0.4 },
        { x: 2100, tilt: -0.3 },
        { x: 2790, tilt: 0.5 },
      ],
    },
    liteSlots: [0, 1, 2, 3],
    hang: { kind: "in-picture" },
    rope: null,
    wideMax: 440,
    wordmark: { x: 1920, y: 950, size: 56, tone: "label" },
    emptyTextY: 700,
    motion: "none",
  },
  {
    id: "bethlehem",
    name: "베들레헴 · 성탄의 별 · 구유",
    note: "별이 뜬 베들레헴 언덕과 구유. 마을과 구유는 사진에 가리지 않아요",
    source: `${FIGMA} · S04 (354:32)`,
    status: "current",
    background: "/wall/themes/bethlehem.jpg",
    preview: "/wall/themes/bethlehem.preview.jpg",
    fallbackColor: "#6B5A7E",
    tone: "dark",
    scene: {
      ...CANVAS,
      line: { midX: 1900, y0: 328, curve: 2.38e-5 },
      strip: { width: 150, height: 450, drop: 0 },
      slots: [
        { x: 758, tilt: -0.5 },
        { x: 1418, tilt: 0.4 },
        { x: 2090, tilt: -0.3 },
        { x: 2764, tilt: 0.5 },
      ],
    },
    liteSlots: [0, 1, 2, 3],
    hang: { kind: "in-picture" },
    rope: null,
    wideMax: 400,
    wordmark: { x: 1920, y: 52, size: 60, tone: "cream" },
    emptyTextY: 640,
    motion: "none",
  },
  {
    id: "sunset-window",
    name: "붉은 노을 · 크리스마스 해안창",
    note: "붉은 노을이 지는 바다 창가. 해는 사진 사이로 보여요",
    source: `${FIGMA} · C01 (354:3)`,
    status: "current",
    background: "/wall/themes/sunset-window.jpg",
    preview: "/wall/themes/sunset-window.preview.jpg",
    fallbackColor: "#A8543A",
    tone: "dark",
    scene: {
      ...CANVAS,
      line: { midX: 2070, y0: 290, curve: 1.58e-5 },
      strip: { width: 180, height: 540, drop: 20 },
      slots: [
        { x: 1140, tilt: -0.7 },
        { x: 1760, tilt: 0.5 },
        { x: 2420, tilt: -0.4 },
        { x: 3020, tilt: 0.7 },
      ],
    },
    liteSlots: [0, 1, 2, 3],
    hang: PEG,
    rope: { x1: 748, x2: 3392, color: TWINE, width: 6 },
    wideMax: 400,
    wordmark: { x: 2070, y: 916, size: 60, tone: "cream" },
    emptyTextY: 620,
    motion: "none",
  },
  {
    id: "pastel-coast",
    name: "파스텔 일몰 · 해안 창가",
    note: "연한 분홍빛 일몰의 바다 창가",
    source: `${FIGMA} · C02 (354:7)`,
    status: "current",
    background: "/wall/themes/pastel-coast.jpg",
    preview: "/wall/themes/pastel-coast.preview.jpg",
    fallbackColor: "#D9A98F",
    tone: "light",
    scene: {
      ...CANVAS,
      line: { midX: 2015, y0: 258, curve: 1.4e-5 },
      strip: { width: 180, height: 540, drop: 20 },
      slots: [
        { x: 1040, tilt: -0.7 },
        { x: 1660, tilt: 0.5 },
        { x: 2280, tilt: -0.4 },
        { x: 2920, tilt: 0.7 },
      ],
    },
    liteSlots: [0, 1, 2, 3],
    hang: PEG,
    rope: { x1: 606, x2: 3424, color: TWINE, width: 6 },
    wideMax: 400,
    wordmark: { x: 2015, y: 900, size: 60, tone: "ink" },
    emptyTextY: 600,
    motion: "none",
  },
  {
    id: "festive-lights",
    name: "전구·포인세티아 · 성탄 바다",
    note: "전구 줄과 포인세티아. 사진은 그림 속 전구 줄에 걸려요",
    source: `${FIGMA} · C03 (354:11)`,
    status: "current",
    background: "/wall/themes/festive-lights.jpg",
    preview: "/wall/themes/festive-lights.preview.jpg",
    fallbackColor: "#C99A78",
    tone: "light",
    scene: {
      ...CANVAS,
      line: { midX: 1880, y0: 305, curve: 2.9e-5 },
      strip: { width: 170, height: 510, drop: 18 },
      slots: [
        { x: 960, tilt: -0.7 },
        { x: 1540, tilt: 0.5 },
        { x: 2120, tilt: -0.4 },
        { x: 2700, tilt: 0.7 },
      ],
    },
    liteSlots: [0, 1, 2, 3],
    hang: PEG,
    rope: null,
    wideMax: 400,
    wordmark: { x: 1880, y: 906, size: 60, tone: "ink" },
    emptyTextY: 640,
    motion: "none",
  },
  {
    id: "winter-sea",
    name: "차분한 겨울 해안 · 미니멀",
    note: "장식을 덜어 낸 겨울 바다 창가",
    source: `${FIGMA} · C04 (354:15)`,
    status: "current",
    background: "/wall/themes/winter-sea.jpg",
    preview: "/wall/themes/winter-sea.preview.jpg",
    fallbackColor: "#C9B3B5",
    tone: "light",
    scene: {
      ...CANVAS,
      line: { midX: 1850, y0: 250, curve: 1.7e-5 },
      strip: { width: 185, height: 554, drop: 20 },
      slots: [
        { x: 950, tilt: -0.7 },
        { x: 1550, tilt: 0.5 },
        { x: 2150, tilt: -0.4 },
        { x: 2750, tilt: 0.7 },
      ],
    },
    liteSlots: [0, 1, 2, 3],
    hang: PEG,
    rope: { x1: 528, x2: 3172, color: TWINE, width: 6 },
    wideMax: 400,
    wordmark: { x: 1850, y: 936, size: 60, tone: "ink" },
    emptyTextY: 600,
    motion: "none",
  },
  {
    id: "night-window",
    name: "제주 밤 11시 창가 (이전 장면)",
    note: "FOLLOW THE LIGHTS 때의 밤 장면. 기록용으로 남겨 뒀어요",
    source: "Figma FTL · 미디어월 (Wall / Composite preview v3)",
    status: "legacy",
    background: WALL_CONFIG.scene.background,
    preview: "/wall/themes/night-window.preview.jpg",
    fallbackColor: "#0B0806",
    tone: "dark",
    scene: WALL_CONFIG.scene,
    liteSlots: WALL_CONFIG.liteSlots,
    hang: BRASS,
    rope: null,
    wideMax: 340,
    wordmark: null,
    emptyTextY: WALL_CONFIG.scene.line.y0 + 281,
    motion: "none",
  },
];

/**
 * The theme a wall shows before staff choose one. Picked by Claude on 2026-11-13 from the eight
 * Figma candidates (the Figma "최종 확인용 캔버스" is still empty): the plain plaster wall is
 * named after the brand line 평화의 벽 and is the calmest backdrop for photos. The user confirms
 * or changes it in /admin → 설정 → 미디어월 배경.
 */
export const DEFAULT_WALL_THEME = "peace-wall";

export function getWallTheme(id: string | null | undefined): WallTheme {
  return (
    WALL_THEMES.find((t) => t.id === id) ?? WALL_THEMES.find((t) => t.id === DEFAULT_WALL_THEME)!
  );
}

/** The look of a wall nobody has configured: the default theme, no rotation. */
export function defaultWallLook(): WallLook {
  return {
    theme: DEFAULT_WALL_THEME,
    rotate: false,
    rotateMinutes: ROTATE_MINUTES.default,
    rotation: [],
  };
}
