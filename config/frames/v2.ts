import type { FrameDecoration, FrameDefinition, FrameSlot } from "@/lib/compositor/types";
import { HAND_TEXT } from "@/config/hand-fonts";

/**
 * 「틀 선택 v2」 (2026-11-22): seven cards on the booth's frame picker, some with options (colour,
 * logo). Each combination is its own FrameDefinition with its own id, so the server, the wall and
 * the AI check (which cut the photo up by slot) see an ordinary frame.
 *
 * Every number below is measured in the Figma file ZbeBrS0o5012SNFrGZNyIU, page "SS 02 · 네컷
 * 프레임 · 휴대폰 · 미디어월 (새 흐름)": the `📷` layers are the photo slots (position, size and
 * rotation from each layer's absolute transform), the rest is exported art under
 * public/frames/v2/ (backgrounds with the photo layers hidden, the tape overlays, the two-line
 * STUDIO SHALOM logo as outlined paths). Rotations are clockwise degrees, about the layer's own
 * top-left corner, as Figma stores them.
 */

const V2 = "/frames/v2";
/** The two-line STUDIO / SHALOM logo (Figma 868:1658), exported at 170 × 40. */
const LOGO_ASPECT = 40 / 170;

function logo(x: number, y: number, width: number, color: string, on: string): FrameDecoration {
  return {
    type: "image",
    src: `${V2}/logo-${color.slice(1).toLowerCase()}.svg`,
    x,
    y,
    width,
    height: width * LOGO_ASPECT,
    brand: { color, on },
  };
}

function art(src: string, width: number, height: number): FrameDecoration {
  return { type: "image", src: `${V2}/${src}`, x: 0, y: 0, width, height };
}

/** A photo slot from a `📷` layer: top-left, size, clockwise degrees about that corner. */
function slot(x: number, y: number, width: number, height: number, deg = 0): FrameSlot {
  return deg
    ? { x, y, width, height, rotation: { deg, pivot: { x, y } } }
    : { x, y, width, height };
}

const photos = (n: number): FrameDecoration[] =>
  Array.from({ length: n }, (_, i) => ({ type: "photo", slot: i }) as const);

type Pt = { x: number; y: number };
/** A point in the axes of a layer at `origin` turned `deg` clockwise. */
function local(origin: Pt, deg: number, p: Pt): Pt {
  const r = (deg * Math.PI) / 180;
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: dx * Math.cos(r) + dy * Math.sin(r), y: -dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * The handwriting group (Figma 880:1717, 877:1664) turned into data that follows the text's
 * measured width: the heart keeps its gap after the end of the text, the underline its insets.
 * The SVGs carry a stroke margin around the vector layer (svg size − layer size): `pad`.
 */
function hand(spec: {
  text: { x: number; y: number; deg: number; width: number; height: number };
  scale: number;
  color: string;
  heart: { src: string; x: number; y: number; w: number; h: number; deg: number; svg: number };
  underline: {
    src: string;
    x: number;
    y: number;
    w: number;
    h: number;
    svgW: number;
    svgH: number;
  };
}): FrameDecoration {
  const o = { x: spec.text.x, y: spec.text.y };
  const heart = local(o, spec.text.deg, spec.heart);
  const under = local(o, spec.text.deg, spec.underline);
  return {
    type: "hand",
    text: HAND_TEXT,
    x: o.x,
    y: o.y,
    deg: spec.text.deg,
    boxHeight: spec.text.height,
    scale: spec.scale,
    color: spec.color,
    heart: {
      src: `${V2}/${spec.heart.src}`,
      dx: heart.x - spec.text.width,
      dy: heart.y,
      padX: (spec.heart.svg - spec.heart.w) / 2,
      padY: (spec.heart.svg - spec.heart.h) / 2,
      width: spec.heart.svg,
      height: spec.heart.svg,
      deg: spec.heart.deg,
    },
    underline: {
      src: `${V2}/${spec.underline.src}`,
      dx: under.x,
      dy: under.y,
      trimEnd: spec.text.width - (under.x + spec.underline.w),
      padX: (spec.underline.svgW - spec.underline.w) / 2,
      padY: (spec.underline.svgH - spec.underline.h) / 2,
      height: spec.underline.svgH,
    },
  };
}

// ── 필름 3컷 (Figma 741:124, 868:1650, 836:1607, 868:1664) ─────────────────────────────────────
const FILM3 = {
  mono: { bg: "#201B1A", logo: "#C7C2BA", label: "흑백", en: "B&W", zh: "黑白" },
  sepia: { bg: "#2B1D14", logo: "#EBDBC4", label: "세피아", en: "Sepia", zh: "复古棕" },
} as const;

function film3(tone: keyof typeof FILM3, withLogo: boolean): FrameDefinition {
  const c = FILM3[tone];
  // With the logo the three photos are 562.67 tall to leave the bottom edge for it.
  const h = withLogo ? 1688 / 3 : 580;
  const slots = [0, 1, 2].map((i) => slot(14, 14 + i * (h + 16), 572, h));
  return {
    id: `film3-${tone}-${withLogo ? "logo" : "plain"}`,
    name: `Film 3 · ${tone} · ${withLogo ? "logo" : "no logo"}`,
    label: `필름 3컷 · ${c.label} · ${withLogo ? "로고" : "로고 없음"}`,
    labelEn: `Film · 3 shots · ${c.en}${withLogo ? " · logo" : ""}`,
    labelZh: `胶片 3格 · ${c.zh}${withLogo ? " · 标志" : ""}`,
    outputWidth: 600,
    outputHeight: 1800,
    background: { type: "solid", color: c.bg },
    photoTone: tone,
    slots,
    decorations: [...photos(3), ...(withLogo ? [logo(215, 1745.29, 170, c.logo, c.bg)] : [])],
  };
}

// ── 필름 4컷 · 네임펜 (Figma 880:1702 크림, 880:1719 빨강) ─────────────────────────────────────
const FILM4 = {
  cream: { bg: "#F6F1E8", ink: "#1A1717", logo: "#2B1A10", label: "크림", en: "Cream", zh: "米色" },
  red: { bg: "#7A2430", ink: "#F6F1E8", logo: "#F6F1E8", label: "빨강", en: "Red", zh: "红色" },
} as const;

function film4(color: keyof typeof FILM4): FrameDefinition {
  const c = FILM4[color];
  const pen = c.ink.slice(1).toLowerCase();
  return {
    id: `film4-${color}`,
    name: `Film 4 · ${color}`,
    label: `필름 4컷 · ${c.label}`,
    labelEn: `Film · 4 shots · ${c.en}`,
    labelZh: `胶片 4格 · ${c.zh}`,
    outputWidth: 600,
    outputHeight: 1800,
    background: { type: "solid", color: c.bg },
    slots: [36, 426, 816, 1206].map((y) => slot(30, y, 540, 372)),
    decorations: [
      ...photos(4),
      hand({
        text: { x: 38.931, y: 1600, deg: 3, width: 326, height: 56 },
        scale: 1,
        color: c.ink,
        heart: {
          src: `hand-heart-film4-${pen}.svg`,
          x: 374.649,
          y: 1615.53,
          w: 28.282,
          h: 27.255,
          deg: -6,
          svg: 32,
        },
        underline: {
          src: `hand-underline-film4-${pen}.svg`,
          x: 44.091,
          y: 1663.375,
          w: 309.6,
          h: 12.9,
          svgW: 313,
          svgH: 16,
        },
      }),
      logo(420, 1721.223, 150, c.logo, c.bg),
    ],
  };
}

// ── 폴라로이드 1컷 (Figma 873:1663, 1200 × 1459, photo square) ───────────────────────────────
const polaroid1: FrameDefinition = {
  id: "polaroid1",
  name: "Polaroid 1",
  label: "폴라로이드 1컷",
  labelEn: "Polaroid · 1 shot",
  labelZh: "拍立得 1格",
  outputWidth: 1200,
  outputHeight: 1459,
  background: { type: "solid", color: "#F4F1EA" },
  // The 4:3 photo is cropped to the square from its centre (coverCrop).
  slots: [slot(61, 95, 1077, 1077)],
  decorations: [
    ...photos(1),
    hand({
      text: { x: 75, y: 1214, deg: 3, width: 538, height: 93 },
      // Figma sets the polaroid's Caveat at 74 where the 600 px table has 49.
      scale: 74 / 49,
      color: "#1A1717",
      heart: {
        src: "hand-heart-polaroid1.svg",
        x: 631.447,
        y: 1240.744,
        w: 43.848,
        h: 42.256,
        deg: -6,
        svg: 49,
      },
      underline: {
        src: "hand-underline-polaroid1.svg",
        x: 83,
        y: 1317.029,
        w: 512.13,
        h: 20,
        svgW: 517,
        svgH: 24,
      },
    }),
    logo(942, 1356.56, 196, "#7A7066", "#F4F1EA"),
  ],
};

// ── 폴라로이드 3컷 · 스크랩 (Figma 836:1616) ─────────────────────────────────────────────────
/** The orange VT323 date stamp on each polaroid (Figma 836:1681, 1686, 1691): 34 px, 34 tall. */
function stamp(x: number, y: number, deg: number): FrameDecoration {
  return {
    type: "text",
    text: "{stamp}",
    x,
    y: y + 17,
    size: 34,
    color: "#FF7A1C",
    weight: 400,
    font: "VT323",
    baseline: "middle",
    rotation: { deg, pivot: { x, y } },
    glow: { color: "rgba(255, 115, 26, 0.55)", blur: 6 },
  };
}

const polaroid3: FrameDefinition = {
  id: "polaroid3",
  name: "Polaroid 3 · scrap",
  label: "폴라로이드 3컷",
  labelEn: "Polaroid · 3 shots",
  labelZh: "拍立得 3格",
  outputWidth: 600,
  outputHeight: 1800,
  background: { type: "solid", color: "#EFE7D8" },
  slots: [
    slot(64.738, 93.194, 456, 342, 3.2),
    slot(80.975, 620.979, 456, 342, -2.6),
    slot(61.299, 1132.68, 456, 342, 1.8),
  ],
  decorations: [
    art("polaroid3-base.jpg", 600, 1800),
    ...photos(3),
    stamp(368.379, 412.642, 3.2),
    stamp(415.344, 908.107, -2.6),
    stamp(372.654, 1444.614, 1.8),
    // The masking tape lies over the photos (captions and doodles are in the base: they never
    // touch a photo). A vector with real transparency, exported from the Figma tape layers.
    art("polaroid3-tape.svg", 600, 1800),
    {
      // "Lockup ink" (Figma 836:1700): the four-line lockup, the same art as the cream strip's.
      type: "image",
      src: "/frames/cream-lockup.svg",
      x: 169.18,
      y: 1665,
      width: 261.64,
      height: 261.64 * (156.13 / 422),
      brand: { color: "#0B1026", on: "#EFE7D8" },
    },
  ],
};

// ── 성경 구절 4컷 (Figma 815:413) ────────────────────────────────────────────────────────────
const verse4: FrameDefinition = {
  id: "verse4",
  name: "Bible verse 4",
  label: "성경 구절 4컷",
  labelEn: "Bible verse · 4 shots",
  labelZh: "圣经经文 4格",
  outputWidth: 600,
  outputHeight: 1800,
  background: { type: "solid", color: "#F2EBE0" },
  slots: [104, 474, 844, 1214].map((y) => slot(36, y, 528, 300)),
  decorations: [
    // Ivory gradient, "Christmas Village 2026", the rule and the Matthew 5:9 verse (NIV).
    art("verse4-base.jpg", 600, 1800),
    ...photos(4),
    logo(414, 1729.223, 150, "#2B1A10", "#E6DCCB"),
  ],
};

// ── 체크 2컷 (Figma 856:1610 빨강 · 795:383 파랑) ───────────────────────────────────────────
const checkRed: FrameDefinition = {
  id: "check2-red",
  name: "Plaid 2 · red",
  label: "체크 2컷 · 빨강",
  labelEn: "Plaid · 2 shots · Red",
  labelZh: "格纹 2格 · 红色",
  outputWidth: 600,
  outputHeight: 1800,
  background: { type: "solid", color: "#843F48" },
  slots: [slot(128, 303, 344, 354, 1), slot(128, 868, 344, 354, -1)],
  decorations: [
    art("check2-red-base.jpg", 600, 1800),
    ...photos(2),
    art("check2-red-tape.svg", 600, 1800),
    logo(188, 1607, 230, "#2B1A10", "#F7F1E7"),
  ],
};

const checkBlue: FrameDefinition = {
  id: "check2-blue",
  name: "Plaid 2 · blue",
  label: "체크 2컷 · 파랑",
  labelEn: "Plaid · 2 shots · Blue",
  labelZh: "格纹 2格 · 蓝色",
  outputWidth: 600,
  outputHeight: 1800,
  background: { type: "solid", color: "#222B3C" },
  slots: [slot(142, 313, 316, 362), slot(142, 993, 316, 362)],
  decorations: [
    art("check2-blue-base.jpg", 600, 1800),
    ...photos(2),
    logo(188, 1612, 230, "#2B1A10", "#F7F1E7"),
  ],
};

// ── 레이스 1컷 (Figma 795:407, 1200 × 1500, oval photo) ─────────────────────────────────────
const lace1: FrameDefinition = {
  id: "lace1",
  name: "Lace 1",
  label: "레이스 1컷",
  labelEn: "Lace · 1 shot",
  labelZh: "蕾丝 1格",
  outputWidth: 1200,
  outputHeight: 1500,
  background: { type: "solid", color: "#969F7F" },
  slots: [{ ...slot(384, 430, 431, 620), shape: "ellipse" }],
  decorations: [
    art("lace1-base.jpg", 1200, 1500),
    ...photos(1),
    logo(201.5, 1164.84, 230, "#2B1A10", "#F7F1E7"),
  ],
};

export const FILM3_VARIANTS = {
  "mono-logo": film3("mono", true),
  "mono-plain": film3("mono", false),
  "sepia-logo": film3("sepia", true),
  "sepia-plain": film3("sepia", false),
} as const;
export const FILM4_VARIANTS = { cream: film4("cream"), red: film4("red") } as const;

/** Every v2 frame, each option combination once. */
export const V2_FRAMES: readonly FrameDefinition[] = [
  ...Object.values(FILM3_VARIANTS),
  ...Object.values(FILM4_VARIANTS),
  polaroid1,
  polaroid3,
  verse4,
  checkRed,
  checkBlue,
  lace1,
];

// ── The seven cards ─────────────────────────────────────────────────────────────────────────

export type FrameCardId =
  "film3" | "film4" | "polaroid1" | "polaroid3" | "verse4" | "check2" | "lace1";

export type OptionKey = "color" | "logo";
export type OptionValue = "mono" | "sepia" | "logoOn" | "logoOff" | "cream" | "red" | "blue";
export type FrameOptions = Partial<Record<OptionKey, OptionValue>>;

export interface FrameCardOption {
  key: OptionKey;
  /** Two choices, the first is the default. */
  values: readonly [OptionValue, OptionValue];
}

export interface FrameCard {
  id: FrameCardId;
  /** Empty: "이 틀로 찍기" goes straight to the camera. */
  options: readonly FrameCardOption[];
  /** The frame for a full set of options. */
  frame: (options: FrameOptions) => FrameDefinition;
}

function only(frame: FrameDefinition): FrameCard["frame"] {
  return () => frame;
}

export const FRAME_CARDS: readonly FrameCard[] = [
  {
    id: "film3",
    options: [
      { key: "color", values: ["mono", "sepia"] },
      { key: "logo", values: ["logoOn", "logoOff"] },
    ],
    frame: (o) =>
      FILM3_VARIANTS[
        `${o.color === "sepia" ? "sepia" : "mono"}-${o.logo === "logoOff" ? "plain" : "logo"}`
      ],
  },
  {
    id: "film4",
    options: [{ key: "color", values: ["cream", "red"] }],
    frame: (o) => FILM4_VARIANTS[o.color === "red" ? "red" : "cream"],
  },
  { id: "polaroid1", options: [], frame: only(polaroid1) },
  { id: "polaroid3", options: [], frame: only(polaroid3) },
  { id: "verse4", options: [], frame: only(verse4) },
  {
    id: "check2",
    options: [{ key: "color", values: ["red", "blue"] }],
    frame: (o) => (o.color === "blue" ? checkBlue : checkRed),
  },
  { id: "lace1", options: [], frame: only(lace1) },
];

/** 필름 3컷 is preselected for every guest. */
export const DEFAULT_CARD_ID: FrameCardId = "film3";

export function getCard(id: string | null | undefined): FrameCard {
  return FRAME_CARDS.find((c) => c.id === id) ?? FRAME_CARDS[0]!;
}

/** The default of every option of a card. */
export function defaultOptions(card: FrameCard): FrameOptions {
  return Object.fromEntries(card.options.map((o) => [o.key, o.values[0]]));
}

/** Only values the card offers; anything else falls back to that option's default. */
export function cleanOptions(card: FrameCard, options: FrameOptions): FrameOptions {
  return Object.fromEntries(
    card.options.map((o) => [
      o.key,
      options[o.key] && o.values.includes(options[o.key]!) ? options[o.key] : o.values[0],
    ]),
  );
}

/** The card a v2 frame id belongs to, or null for any other frame. */
export function cardOfFrame(frameId: string): FrameCard | null {
  for (const card of FRAME_CARDS) {
    const combos = card.options.reduce<FrameOptions[]>(
      (acc, o) => acc.flatMap((a) => o.values.map((v) => ({ ...a, [o.key]: v }))),
      [{}],
    );
    if (combos.some((c) => card.frame(c).id === frameId)) return card;
  }
  return null;
}

/** True when the frame carries the handwriting (its font is chosen per session). */
export function usesHandwriting(frame: FrameDefinition): boolean {
  return frame.decorations.some((d) => d.type === "hand");
}
