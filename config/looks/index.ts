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
 *  - skin keeps its hue: every skin tone lies on one narrow hue line;
 *  - the light reaches the face first (2026-11-28): no skin tone, light or deep, comes out darker
 *    than it went in. A look that wants a deep room or a hard black takes it from the tones under
 *    the skin (the toe of `curve`) and gives the skin its light back with `skinLight`. Before this
 *    Lamp dimmed every face and Flash took a third of the light off the deepest skin tone
 *    (tests/unit/looks-engine.test.ts keeps the bar).
 * Grain is the tooth of the paper, not noise on a face: at most 0.024, never coarser than 600
 * grains across the photo.
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
  skinLight: 0,
};

const HOUSE_GRAIN: LookGrain = { amount: 0.016, size: 760, chroma: 0.25 };

export const LOOKS: readonly LookDefinition[] = [
  {
    id: "paper",
    name: "Paper",
    nameKo: "페이퍼",
    summary: "갓 뽑은 사진관 인화. 누런 기를 걷어 내고 흰색은 깨끗하게, 얼굴은 한 톤 밝게.",
    why: "무보정·카메라 고유 색 선호(2026 보도)를 따른 기준 룩. 색은 건드리지 않고 조명의 누런 기와 탁한 중간톤만 정리한다. 입자도 거의 없다.",
    grade: {
      ...HOUSE,
      exposure: 0.04,
      balance: { a: -0.003, b: -0.014 },
      curve: [
        [0, 0.02],
        [0.1, 0.096],
        [0.25, 0.258],
        [0.5, 0.542],
        [0.75, 0.808],
        [0.9, 0.924],
        [1, 0.972],
      ],
      saturation: 1,
      highlightDesat: 0.12,
      highlightTint: { a: 0, b: 0.002 },
      skinChroma: 1.05,
      skinLight: 0.006,
    },
    grain: { amount: 0.007, size: 900, chroma: 0.15 },
    vignette: 0.03,
    halation: 0.08,
    strength: 1,
  },
  {
    id: "linen",
    name: "Linen",
    nameKo: "리넨",
    summary: "밝고 공기 많은 크림빛 인물 톤. 대비를 풀고 그림자를 연다.",
    why: "인물용 컬러 네거티브의 중간 대비·따뜻한 팔레트·자연스러운 피부(Kodak 데이터시트, The Darkroom)를 방향으로 삼았다. 기존 「컬러」(필름 35mm)의 개선판.",
    replaces: "film",
    grade: {
      ...HOUSE,
      exposure: 0.1,
      balance: { a: 0.004, b: 0.011 },
      curve: [
        [0, 0.04],
        [0.1, 0.14],
        [0.25, 0.32],
        [0.5, 0.6],
        [0.75, 0.828],
        [0.9, 0.918],
        [1, 0.958],
      ],
      saturation: 0.86,
      highlightDesat: 0.38,
      shadowTint: { a: 0.003, b: 0.004 },
      highlightTint: { a: 0.002, b: 0.01 },
      skinEven: 0.2,
      skinChroma: 0.95,
      skinLight: 0.012,
    },
    grain: { amount: 0.013, size: 820, chroma: 0.2 },
    vignette: 0.04,
    halation: 0.25,
    strength: 1,
  },
  {
    id: "lamp",
    name: "Lamp",
    nameKo: "램프",
    summary: "밤의 전구빛. 방은 호박색으로 깊어지고, 얼굴은 그 불빛을 받아 환하다.",
    why: "전구색은 다 지우지 말고 조금 남기라는 촬영 가이드(Fstoppers, DPS)와 피부 기준으로 맞추고 배경 채도만 낮추는 혼합광 처리를 따랐다. 주황으로 뜨지 않게 피부 띠는 보호한다. 방이 깊어지는 만큼 얼굴이 같이 어두워지던 것을 고쳤다: 어둠은 피부보다 아래 톤에서만 내리고 피부에는 빛을 돌려준다.",
    grade: {
      ...HOUSE,
      exposure: 0.03,
      balance: { a: 0.009, b: 0.039 },
      curve: [
        [0, 0.02],
        [0.1, 0.066],
        [0.25, 0.202],
        [0.5, 0.495],
        [0.75, 0.79],
        [0.9, 0.905],
        [1, 0.948],
      ],
      saturation: 0.94,
      chromaCompress: 0.8,
      density: 0.08,
      shadowDesat: 0.45,
      shadowTint: { a: -0.005, b: -0.012 },
      highlightTint: { a: 0.004, b: 0.013 },
      bands: [
        { hue: 26, width: 32, shift: 2, chroma: 0.93, light: -0.01 },
        { hue: 108, width: 36, shift: -6, chroma: 0.93 },
        { hue: 142, width: 46, shift: 5, chroma: 0.8, light: -0.018 },
        { hue: 262, width: 48, shift: -6, chroma: 0.78 },
      ],
      skinProtect: 1,
      skinChroma: 0.95,
      skinLight: 0.038,
    },
    grain: { ...HOUSE_GRAIN, amount: 0.02, size: 680 },
    vignette: 0.24,
    halation: 0.6,
    strength: 1,
  },
  {
    id: "pine",
    name: "Pine",
    nameKo: "파인",
    summary: "겨울 저녁의 서늘한 빛. 배경과 그림자는 청록으로, 얼굴은 따뜻한 채로.",
    why: "차가운 쪽 네거티브의 깊은 초록·파랑과 낮은 채도(Casual Photophile, The Darkroom의 리뷰)를 방향으로 삼되, 피부가 창백해진다는 같은 리뷰의 지적 때문에 피부 띠는 서늘하게 만들지 않는다.",
    grade: {
      ...HOUSE,
      exposure: 0,
      balance: { a: -0.012, b: -0.009 },
      curve: [
        [0, 0.03],
        [0.1, 0.098],
        [0.25, 0.238],
        [0.5, 0.505],
        [0.75, 0.778],
        [0.9, 0.908],
        [1, 0.96],
      ],
      saturation: 0.84,
      shadowTint: { a: -0.014, b: -0.008 },
      highlightTint: { a: -0.002, b: 0.002 },
      bands: [
        { hue: 26, width: 30, shift: 0, chroma: 0.84, light: -0.02 },
        { hue: 108, width: 34, shift: 6, chroma: 0.72 },
        { hue: 142, width: 48, shift: 12, chroma: 0.82, light: -0.04 },
        { hue: 262, width: 46, shift: -12, chroma: 0.9 },
      ],
      skinProtect: 1,
      skinChroma: 1.14,
      skinLight: 0.008,
    },
    grain: HOUSE_GRAIN,
    vignette: 0.1,
    halation: 0.15,
    strength: 1,
  },
  {
    id: "album",
    name: "Album",
    nameKo: "앨범",
    summary: "오래 넣어 둔 앨범 속 사진. 색이 절반쯤 빠지고, 밝은 곳은 장밋빛 종이색으로 바랜다.",
    why: "'빛바랜 듯한 색감'의 디카·필름 유행(한경, 에스콰이어 2026)을 받되, 리뷰들이 싸구려의 표시로 꼽는 과한 블랙 리프트는 피했다. 검정은 10/255 안쪽에서 멈춘다.",
    grade: {
      ...HOUSE,
      exposure: 0,
      balance: { a: 0.014, b: 0.02 },
      curve: [
        [0, 0.044],
        [0.1, 0.14],
        [0.25, 0.292],
        [0.5, 0.522],
        [0.75, 0.756],
        [0.9, 0.9],
        [1, 0.945],
      ],
      saturation: 0.5,
      chromaCompress: 0.65,
      highlightDesat: 0.4,
      shadowTint: { a: -0.013, b: -0.004 },
      highlightTint: { a: 0.007, b: 0.005 },
      skinProtect: 1,
      skinChroma: 1.6,
      skinLight: 0.008,
    },
    grain: { amount: 0.02, size: 660, chroma: 0.35 },
    vignette: 0.14,
    halation: 0.3,
    strength: 1,
  },
  {
    id: "flash",
    name: "Flash",
    nameKo: "플래시",
    summary: "직광 플래시 스냅. 얼굴이 가장 환하고, 검정은 단단하고, 모서리는 어둡다.",
    why: "2026년 디카·직광 플래시 유행(에스콰이어, 얼루어)에 맞춘 대비 있는 룩. 기존 「플래시 느낌」은 채널별 곡선이라 밝은 피부가 날아갔다. 숄더를 두어 고쳤다. 짙은 피부가 검정과 같이 가라앉던 것도 고쳤다: 단단한 검정은 피부보다 아래 톤에서만 만든다.",
    replaces: "flash",
    grade: {
      ...HOUSE,
      exposure: 0.07,
      balance: { a: -0.005, b: -0.016 },
      curve: [
        [0, 0.01],
        [0.1, 0.05],
        [0.25, 0.21],
        [0.5, 0.61],
        [0.75, 0.876],
        [0.9, 0.946],
        [1, 0.98],
      ],
      saturation: 0.92,
      chromaCompress: 0.7,
      density: 0.07,
      highlightDesat: 0.12,
      shadowDesat: 0.6,
      shadowTint: { a: -0.002, b: -0.007 },
      highlightTint: { a: -0.001, b: -0.002 },
      skinChroma: 1.1,
      skinLight: 0.05,
    },
    grain: { amount: 0.018, size: 640, chroma: 0.5 },
    vignette: 0.34,
    halation: 0,
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
        [0.1, 0.082],
        [0.25, 0.228],
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
    grain: { amount: 0.024, size: 620, chroma: 0 },
    vignette: 0.18,
    halation: 0.35,
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
        [0.1, 0.094],
        [0.25, 0.24],
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
    halation: 0.3,
    strength: 1,
  },
];

export const LOOK_IDS = LOOKS.map((look) => look.id);

/**
 * "원본": no look at all. Every frame starts with it (a user decision, 2026-11-26: "색감은 모든
 * 템플릿에서 아무것도 없는 걸 원칙으로 하고 유저가 직접 고를 수 있게"); the guest may pick one of
 * the looks on the photo choice screen. A photo with no look keeps its frame's own `photoTone`
 * (흑백, 세피아, ...), exactly as with looks off.
 */
export const NO_LOOK = "none";

export function getLook(id: string | null | undefined): LookDefinition | undefined {
  return LOOKS.find((look) => look.id === id);
}

/** Where the booth fetches a look's LUT. */
export function lookCubeUrl(id: string): string {
  return `/looks/${id}.cube`;
}
