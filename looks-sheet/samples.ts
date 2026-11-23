/**
 * The sample pictures of the comparison sheet. Every photo is synthetic: made by an image
 * generator for this page on 2026-11-23, showing nobody who exists, so there is no portrait or
 * copyright holder. The chart is drawn by arithmetic (lib/looks/chart.ts).
 */
export interface Sample {
  id: string;
  /** Short Korean label on the chip. */
  label: string;
  /** What this sample is there to show. */
  tests: string;
  /** A picture file, or "chart" for the drawn test chart. */
  src: string;
}

export const SYNTHETIC_NOTE =
  "합성 이미지입니다. 이 페이지를 위해 이미지 생성 모델(Higgsfield · Z Image)로 2026-11-23에 만들었고, 실제 인물이 아닙니다.";

export const SAMPLES: readonly Sample[] = [
  {
    id: "booth-friends",
    label: "부스 · 친구",
    tests: "종이 배경지 앞 친구 셋, 빨강·초록 니트. 실제 부스와 가장 비슷한 조건.",
    src: "/looks/samples/07-booth-friends.jpg",
  },
  {
    id: "booth-family",
    label: "부스 · 가족",
    tests: "여러 연령대 가족 단체. 어두운 외투와 밝은 배경이 함께 있다.",
    src: "/looks/samples/08-booth-family.jpg",
  },
  {
    id: "skin-tones",
    label: "피부톤 3단계",
    tests: "아주 어두운·중간·아주 밝은 피부가 한 장에. 주황이나 회색으로 뜨는지 본다.",
    src: "/looks/samples/01-skin-tones.jpg",
  },
  {
    id: "group",
    label: "단체 · 전구 조명",
    tests: "여덟 명 단체. 천장 전구가 하얗게 날아간 부분이 어떻게 눕는지 본다.",
    src: "/looks/samples/02-group.jpg",
  },
  {
    id: "low-light",
    label: "어두운 실내",
    tests: "줄전구만 있는 방. 그림자가 탁해지거나 색 노이즈가 올라오는지 본다.",
    src: "/looks/samples/03-low-light.jpg",
  },
  {
    id: "backlit",
    label: "역광",
    tests: "밝은 트리를 등진 두 사람. 얼굴이 묻히는 정도와 밝은 전구의 번짐.",
    src: "/looks/samples/04-backlit.jpg",
  },
  {
    id: "decorations",
    label: "빨강·초록 장식",
    tests: "빨간 오너먼트, 초록 트리, 전구. 빨강·초록이 형광처럼 튀는지 본다.",
    src: "/looks/samples/05-decorations.jpg",
  },
  {
    id: "mixed-light",
    label: "혼합 광원",
    tests: "차가운 LED 형광등 아래, 뒤에 주황 전구. 피부에 도는 녹색기를 본다.",
    src: "/looks/samples/06-mixed-light.jpg",
  },
  {
    id: "chart",
    label: "색 차트",
    tests: "피부색 12단계, 장식 빨강·LED 빨강·솔잎·LED 초록·전구색, 회색 단계, 전체 색상.",
    src: "chart",
  },
];
