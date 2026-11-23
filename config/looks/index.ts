import type { HueBand, LookDefinition, LookGrade, LookGrain } from "@/lib/looks/types";

/**
 * STUDIO SHALOM looks. One house stock, several developments: every look starts from `HOUSE` and
 * changes only what its name says, so strips with different looks still sit together on the wall.
 *
 * Edit the numbers here, then `npm run looks:build` writes public/looks/<id>.cube again
 * (tests/unit/looks-cube.test.ts fails while a .cube and these numbers disagree).
 *
 * Where the numbers come from (docs/research/color-market-research.md):
 *  - shoulder and toe instead of clipping: film's characteristic curve (Kodak sensitometry);
 *  - colour held back, never pushed: the film simulations and preset reviews all mute, and the
 *    first tell of a cheap filter is global saturation;
 *  - saturated colour gets denser, not brighter: subtractive dye;
 *  - shadows lose colour and are not lifted: the camera's colour noise lives there;
 *  - skin keeps its hue: every skin tone lies on one narrow hue line.
 * The two tints are the brand's own: shadows lean toward `ink` (#2b1a10), highlights toward
 * `paper` (#f6eee4).
 */

/** Hue bands of the house stock. Christmas reds and greens are the ones that go fluorescent. */
const HOUSE_BANDS: readonly HueBand[] = [
  // Reds a touch toward orange and held back: an LED red clips one channel and turns flat.
  { hue: 26, width: 30, shift: 1.5, chroma: 0.92, light: -0.012 },
  // Yellow lamps toward amber rather than lemon.
  { hue: 108, width: 34, shift: -5, chroma: 0.92 },
  // Greens deeper and quieter, a step toward pine.
  { hue: 142, width: 44, shift: 7, chroma: 0.8, light: -0.02 },
  // Blues a little toward cyan and calmer.
  { hue: 262, width: 46, shift: -6, chroma: 0.88 },
];

export const HOUSE: LookGrade = {
  exposure: 0,
  balance: { a: 0, b: 0 },
  curve: [
    [0, 0.026],
    [0.1, 0.098],
    [0.25, 0.243],
    [0.5, 0.512],
    [0.75, 0.782],
    [0.9, 0.912],
    [1, 0.968],
  ],
  saturation: 0.97,
  chromaCompress: 0.45,
  density: 0.05,
  highlightDesat: 0.35,
  shadowDesat: 0.35,
  shadowTint: { a: 0.0015, b: 0.003 },
  highlightTint: { a: 0.0008, b: 0.0045 },
  bands: HOUSE_BANDS,
  skinProtect: 0.85,
  skinEven: 0.12,
  skinChroma: 1,
};

const HOUSE_GRAIN: LookGrain = { amount: 0.016, size: 760, chroma: 0.25 };

export const LOOKS: readonly LookDefinition[] = [
  {
    id: "paper",
    name: "Paper",
    nameKo: "페이퍼",
    summary: "찍힌 그대로에 가깝게. 밝은 곳만 종이 흰색으로 부드럽게 눕힌다.",
    why: "무보정·카메라 고유 색 선호(2026 보도)와 과보정 피로를 따른 기본값. 채도는 올리지 않고 하이라이트 숄더와 섀도 색 노이즈 정리만 한다.",
    grade: HOUSE,
    grain: { ...HOUSE_GRAIN, amount: 0.011 },
    vignette: 0.06,
    strength: 1,
  },
  {
    id: "linen",
    name: "Linen",
    nameKo: "리넨",
    summary: "따뜻하고 부드러운 인물 톤. 대비를 낮추고 피부를 살짝 밝힌다.",
    why: "인물용 컬러 네거티브의 중간 대비·따뜻한 팔레트·자연스러운 피부(Kodak 데이터시트, The Darkroom)를 방향으로 삼았다. 기존 「컬러」(필름 35mm)의 개선판.",
    replaces: "film",
    grade: {
      ...HOUSE,
      exposure: 0.16,
      balance: { a: 0.003, b: 0.008 },
      curve: [
        [0, 0.036],
        [0.1, 0.116],
        [0.25, 0.272],
        [0.5, 0.538],
        [0.75, 0.788],
        [0.9, 0.904],
        [1, 0.958],
      ],
      saturation: 0.9,
      highlightDesat: 0.45,
      shadowTint: { a: 0.002, b: 0.002 },
      highlightTint: { a: 0.0015, b: 0.008 },
      skinEven: 0.2,
      skinChroma: 0.93,
    },
    grain: { ...HOUSE_GRAIN, amount: 0.017 },
    vignette: 0.06,
    strength: 1,
  },
  {
    id: "lamp",
    name: "Lamp",
    nameKo: "램프",
    summary: "전구 아래의 호박빛. 따뜻함은 남기고 그림자는 깊게.",
    why: "전구색은 다 지우지 말고 조금 남기라는 촬영 가이드(Fstoppers, DPS)와 피부 기준으로 맞추고 배경 채도만 낮추는 혼합광 처리를 따랐다. 주황으로 뜨지 않게 피부 띠는 보호한다.",
    grade: {
      ...HOUSE,
      balance: { a: 0.005, b: 0.02 },
      curve: [
        [0, 0.022],
        [0.1, 0.08],
        [0.25, 0.22],
        [0.5, 0.502],
        [0.75, 0.792],
        [0.9, 0.916],
        [1, 0.966],
      ],
      saturation: 0.95,
      chromaCompress: 0.55,
      density: 0.07,
      shadowDesat: 0.45,
      shadowTint: { a: 0.004, b: 0.007 },
      highlightTint: { a: 0.003, b: 0.015 },
      bands: [
        { hue: 26, width: 30, shift: 2, chroma: 0.9, light: -0.015 },
        { hue: 108, width: 34, shift: -7, chroma: 0.9 },
        { hue: 142, width: 44, shift: 5, chroma: 0.7, light: -0.03 },
        { hue: 262, width: 46, shift: -6, chroma: 0.65 },
      ],
      skinProtect: 1,
      skinChroma: 0.88,
    },
    grain: { ...HOUSE_GRAIN, amount: 0.02, size: 680 },
    vignette: 0.18,
    strength: 1,
  },
  {
    id: "pine",
    name: "Pine",
    nameKo: "파인",
    summary: "차분한 솔잎빛. 초록은 깊게, 전체는 조금 서늘하게.",
    why: "차가운 쪽 네거티브의 깊은 초록·파랑과 낮은 채도(Casual Photophile, The Darkroom의 리뷰)를 방향으로 삼되, 피부가 창백해진다는 같은 리뷰의 지적 때문에 피부 띠는 서늘하게 만들지 않는다.",
    grade: {
      ...HOUSE,
      balance: { a: -0.006, b: -0.004 },
      curve: [
        [0, 0.03],
        [0.1, 0.098],
        [0.25, 0.236],
        [0.5, 0.504],
        [0.75, 0.778],
        [0.9, 0.908],
        [1, 0.962],
      ],
      saturation: 0.88,
      shadowTint: { a: -0.008, b: -0.003 },
      highlightTint: { a: 0.0005, b: 0.004 },
      bands: [
        { hue: 26, width: 30, shift: 1, chroma: 0.88, light: -0.015 },
        { hue: 108, width: 34, shift: 4, chroma: 0.8 },
        { hue: 142, width: 48, shift: 10, chroma: 0.8, light: -0.035 },
        { hue: 262, width: 46, shift: -10, chroma: 0.85 },
      ],
      skinProtect: 1,
    },
    grain: HOUSE_GRAIN,
    vignette: 0.1,
    strength: 1,
  },
  {
    id: "album",
    name: "Album",
    nameKo: "앨범",
    summary: "오래 넣어 둔 앨범 속 사진. 색이 한 톤 빠지고 검정이 부드럽다.",
    why: "'빛바랜 듯한 색감'의 디카·필름 유행(한경, 에스콰이어 2026)을 받되, 리뷰들이 싸구려의 표시로 꼽는 과한 블랙 리프트는 피했다. 검정은 10/255 안쪽에서 멈춘다.",
    grade: {
      ...HOUSE,
      exposure: 0.06,
      balance: { a: 0.004, b: 0.01 },
      curve: [
        [0, 0.042],
        [0.1, 0.118],
        [0.25, 0.262],
        [0.5, 0.515],
        [0.75, 0.756],
        [0.9, 0.876],
        [1, 0.936],
      ],
      saturation: 0.74,
      chromaCompress: 0.6,
      highlightDesat: 0.5,
      shadowTint: { a: -0.004, b: 0.001 },
      highlightTint: { a: 0.004, b: 0.014 },
    },
    grain: { amount: 0.024, size: 620, chroma: 0.3 },
    vignette: 0.14,
    strength: 1,
  },
  {
    id: "flash",
    name: "Flash",
    nameKo: "플래시",
    summary: "직광 플래시로 찍은 스냅. 얼굴은 환하고 배경은 가라앉는다.",
    why: "2026년 디카·직광 플래시 유행(에스콰이어, 얼루어)에 맞춘 대비 있는 룩. 기존 「플래시 느낌」은 채널별 곡선이라 밝은 피부가 날아갔다. 숄더를 두어 고쳤다.",
    replaces: "flash",
    grade: {
      ...HOUSE,
      exposure: 0.12,
      balance: { a: -0.001, b: 0.002 },
      curve: [
        [0, 0.01],
        [0.1, 0.06],
        [0.25, 0.2],
        [0.5, 0.528],
        [0.75, 0.822],
        [0.9, 0.926],
        [1, 0.975],
      ],
      saturation: 1.02,
      chromaCompress: 0.5,
      density: 0.06,
      highlightDesat: 0.55,
      shadowDesat: 0.55,
      shadowTint: { a: -0.001, b: -0.003 },
      highlightTint: { a: 0, b: 0.002 },
    },
    grain: { amount: 0.02, size: 620, chroma: 0.35 },
    vignette: 0.34,
    strength: 1,
  },
  {
    id: "ink",
    name: "Ink",
    nameKo: "잉크",
    summary: "대비 있는 흑백. 피부는 밝게, 검정은 잉크처럼.",
    why: "'과한 보정 없이 흑백'을 내세운 빈티지 포토부스 유행(에스콰이어 2026-09)과 대비 강한 흑백 필름의 인상(The Darkroom)을 따랐다. 기존 「흑백」은 단순 탈색이었다. 빨강 쪽 감도를 높여 피부를 밝히고, 크리스마스 빨강·초록이 같은 회색으로 뭉치지 않게 했다.",
    replaces: "mono",
    grade: {
      ...HOUSE,
      mono: [0.42, 0.5, 0.08],
      curve: [
        [0, 0.02],
        [0.1, 0.074],
        [0.25, 0.212],
        [0.5, 0.508],
        [0.75, 0.812],
        [0.9, 0.93],
        [1, 0.972],
      ],
      saturation: 0,
      shadowTint: { a: 0.0008, b: 0.0016 },
      highlightTint: { a: 0.0004, b: 0.0026 },
      bands: [],
    },
    grain: { amount: 0.026, size: 600, chroma: 0 },
    vignette: 0.14,
    strength: 1,
  },
  {
    id: "walnut",
    name: "Walnut",
    nameKo: "월넛",
    summary: "호두나무색으로 조색한 흑백. 세피아보다 깊고 덜 노랗다.",
    why: "기존 「세피아」는 검정이 46/255까지 떠서 뿌옇고 밝은 곳이 244에서 끊겼다. 조색 인화처럼 그림자는 깊은 갈색, 밝은 곳은 종이색으로 나눠 입혔다.",
    replaces: "sepia",
    grade: {
      ...HOUSE,
      mono: [0.38, 0.52, 0.1],
      curve: [
        [0, 0.03],
        [0.1, 0.09],
        [0.25, 0.232],
        [0.5, 0.512],
        [0.75, 0.792],
        [0.9, 0.912],
        [1, 0.958],
      ],
      saturation: 0,
      balance: { a: 0.01, b: 0.026 },
      shadowTint: { a: 0.01, b: 0.015 },
      highlightTint: { a: 0.004, b: 0.018 },
      bands: [],
    },
    grain: { amount: 0.022, size: 620, chroma: 0 },
    vignette: 0.12,
    strength: 1,
  },
];

export const LOOK_IDS = LOOKS.map((look) => look.id);

export function getLook(id: string | null | undefined): LookDefinition | undefined {
  return LOOKS.find((look) => look.id === id);
}

/** Where the booth fetches a look's LUT. */
export function lookCubeUrl(id: string): string {
  return `/looks/${id}.cube`;
}
