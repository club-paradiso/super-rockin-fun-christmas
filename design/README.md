# 디자인 원본 (Figma) 과 코드의 연결

편집 가능한 원본은 Figma 파일 하나다. 2026-11-11부터 브랜드는 **STUDIO SHALOM** 이다(D73).

- 파일: https://www.figma.com/design/S5hz7sZaXXB2kNc9YrB3cB (file key `S5hz7sZaXXB2kNc9YrB3cB`)
- 지금 쓰는 페이지: `STUDIO SHALOM · Kiosk`, `STUDIO SHALOM · Frame, Phone & Wall`
- 이전 디자인(FOLLOW THE LIGHTS)은 같은 파일의 `ARCHIVE · Follow the Lights` 페이지에 있다. 기록으로만 둔다.
- 네컷 틀 A~D의 배치와 미디어월 장면은 이전 원본 https://www.figma.com/design/ZbeBrS0o5012SNFrGZNyIU
  (D65)에서 옮긴 값 그대로다. 리브랜딩에서 바꾼 것은 틀 안의 로고 락업과 미디어월 그림 속 워드마크뿐이다.
- 이 폴더의 `previews/*.jpg` 는 이전 브랜드(2026-10-13) 화면이다. 새 화면은 `docs/screenshots/` 에
  E2E가 찍는다(`SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts`).

Figma와 코드는 **자동으로 동기화되지 않는다.** Figma에서 바꾼 것은 아래 표의 코드 위치에 같은 값을
옮겨야 실제 부스·미디어월에 반영된다. 반대로 코드를 바꾸면 Figma도 고쳐 둔다.

### Figma에는 있지만 코드에는 아직 없는 것

2026-11-12에 사용자가 작업 중인 Figma(https://www.figma.com/design/ZbeBrS0o5012SNFrGZNyIU, 페이지 `SS 01 ·
키오스크 새 흐름`, `SS 02 · 네컷 프레임 · 휴대폰 · 미디어월`)의 흐름을 반영했다(D77, D78): O 속 별,
2×2 틀, 한국어/English, 이전. 아래는 **일부러 만들지 않았다.**

- **이름 입력 화면.** 사용자 결정(2026-11-12): 만들지 않는다. 코드는 이름을 받지 않는다(개인 정보 규칙).
- **두 장의 선택 카드 동의 화면.** 코드는 "네, 띄워주세요 / 아니요, 저만 볼게요" 두 버튼을 같은 크기로
  보여 준다(같은 원칙). 문구는 사용자 문구 그대로 둔다(D76).
- **격자(grid) 미디어월.** 코드의 미디어월은 빨랫줄 밤 장면 그대로다. 2×2 사진만 넓은 상자로 걸린다(D77).
- **Figma 문구 변경**(예: "6장 모두 다시 찍기", 키오스크 상단 막대의 "처음으로" 위치). 손님 문구는 사용자가
  정한 것만 바꾼다(D76). "처음으로"는 코드에서 화면 아래에 그대로 있다.

## 브랜드 토큰 (D73)

값은 `app/globals.css` 의 `@theme` 에 있다. 다른 브랜드 색을 만들지 않는다.

| 토큰          | 값        | 쓰는 곳                                                         |
| ------------- | --------- | --------------------------------------------------------------- |
| `backdrop`    | `#DDBDA1` | 화면 바탕(무늬·그라데이션·빛 번짐 없음)                         |
| `ink`         | `#2B1A10` | 제목·본문(바탕 위 9.43:1). 흐린 글자는 `ink/75`(5.26:1)         |
| `button`      | `#412D1B` | 채운 버튼. 한 화면에 하나                                       |
| `button-text` | `#F6EEE4` | 버튼 위 글자(11.31:1). 바탕 위 글자로는 쓰지 않는다(1.54:1)     |
| `paper`       | `#F6EEE4` | 카드·입력 칸·시트의 밝은 면 (`button-text` 와 같은 값)          |
| `accent`      | `#7A440E` | 구분선·아이콘·가는 선. 글자로는 24px 이상에서만(바탕 위 4.46:1) |
| `approve`     | `#1B5233` | 관리자 상태 색(승인·온라인). 브랜드 색이 아니다                 |
| `danger`      | `#8F1D14` | 관리자 상태 색(삭제·오류·긴급)                                  |
| `alert`       | `#7C3500` | 관리자 상태 색(검수 대기·응답 지연)                             |

모서리: 버튼은 알약 모양, 카드 24px, 작은 조작 요소 8px. 보조 버튼은 테두리 또는 글자만(ink).

로고 락업은 네 줄을 가운데로 쌓는다: `STUDIO`(Cormorant Garamond 600, 대문자, 자간 0.4em) /
`SHALOM`(Cormorant Garamond 500, 자간 0.04em) / 짧고 가는 구분선 / `평화의 벽`(나눔명조, 자간 0.3em,
띄어쓰기는 보통 한 칸). 화면에서는 진짜 글자다(`components/brand.tsx`, `.brand-lockup`). 화면 글자는
Noto Sans KR 그대로이고, 카운트다운 숫자도 Noto Sans KR 이다(Cormorant의 숫자 10은 IO처럼 보인다).
주제 성구 표기는 `MT 5:9` 이다. 성구 본문은 아직 정하지 않았으므로 어디에도 적지 않는다.

미디어월은 밤 장면을 그대로 두므로 자기 색을 따로 가진다: `app/globals.css` 의 `.wall-stage`
(`--wall-*`). 다른 화면에서 쓰지 않는다.

## 페이지

| 페이지                              | 내용                                            |
| ----------------------------------- | ----------------------------------------------- |
| STUDIO SHALOM · Kiosk               | 부스 화면 흐름. 위 "코드에는 아직 없는 것" 참고 |
| STUDIO SHALOM · Frame, Phone & Wall | 네컷 틀, 휴대폰 화면, 미디어월                  |
| ARCHIVE · Follow the Lights         | 이전 브랜드의 디자인. 기록                      |

## 무엇을 바꾸면 어디를 고치나

| Figma에서 바꾼 것                         | 코드에서 고칠 곳                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 색 변수 (위 "브랜드 토큰")                | `app/globals.css` 의 `@theme` (`--color-*`)                                                                                                                                 |
| 색 변수 `frame/*`                         | 해당 프레임 파일 `config/frames/*.ts`                                                                                                                                       |
| 미디어월 배경 (`Wall/Background — v3`)    | 3840×1080으로 내보내 `public/wall/background-v3.jpg` 를 바꾼다. 빨랫줄·워드마크가 그림 안에 있다(아래 주)                                                                   |
| 글꼴                                      | 앱은 글꼴을 함께 배포한다(`app/layout.tsx`): Noto Sans KR, Cormorant Garamond, 나눔명조. 아래 "글꼴 라이선스"                                                               |
| 네컷 틀 (`Template/A`~`D`)                | `config/frames/<id>.ts` 와 `public/frames/*.svg`. 아래 "프레임 옮기는 법"                                                                                                   |
| 2×2 틀 (`10 네컷 프레임 · 2×2`)           | `config/frames/shalom-grid.ts`, `public/frames/shalom-lockup.svg` (D77)                                                                                                     |
| 부스 문구 (한국어·영어)                   | `lib/kiosk/copy.ts` (D78). 한국어는 사용자 문구 그대로                                                                                                                      |
| 편지지·밀랍 봉인 (KIOSK `편지지`, `봉인`) | `LetterSheet`·`WaxSeal` (`components/kiosk/ui.tsx`), `.letter-sheet`·`.wax-seal` (`app/globals.css`), 봉인 그림 `public/brand/wax-seal.webp` (D79). 봉인은 처음·QR 화면에만 |
| 미디어월 사진 자리·기울기·줄 높이         | `config/wall.ts` 의 `scene` (`slots`, `strip`, `line`). Figma `Composite preview v3` 의 값을 옮긴다                                                                         |
| 미디어월 문구 (닫힘·잠시 멈춤·빈 줄)      | `components/wall/wall-app.tsx`                                                                                                                                              |
| 부스 문구·버튼                            | `components/kiosk/kiosk-app.tsx`, 버튼·배경·글자 크기는 `app/globals.css` 의 `.booth-*`                                                                                     |
| 관리자 문구·상태 색                       | `components/admin/*`, 상태 이름과 색은 `components/admin/labels.ts`                                                                                                         |
| 사인물                                    | 코드 없음. Figma에서 PDF(벡터)로 내보내 인쇄한다                                                                                                                            |

### 프레임 옮기는 법

프레임은 코드에서 데이터다(`lib/compositor/types.ts` 의 `FrameDefinition`). Figma 컴포넌트의 레이어가
그 필드와 1:1로 대응한다.

| Figma 레이어                       | `FrameDefinition` 필드                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| 컴포넌트 크기 (600×1800)           | `outputWidth`, `outputHeight`. 저장할 때 2배(`KIOSK_CONFIG.outputScale`)       |
| 컴포넌트 채우기                    | `background` (단색 또는 위→아래 그라데이션)                                    |
| `Photo/Slot` 4개                   | `slots[i]`: x, y, width, height(4:3), 기울기 `rotation`                        |
| 사각형 (액자·창틀·줄·폴라로이드)   | `decorations` 의 `rect`: 색 또는 그라데이션, 모서리, 기울기, 그림자            |
| 영문 로고·제목, 반짝이, 집게, 빛길 | `decorations` 의 `image`: Figma에서 SVG로 내보낸 파일(`public/frames/`)과 위치 |
| 한글 문구                          | `decorations` 의 `text` (Noto Sans KR)                                         |
| 레이어 순서                        | `decorations` 순서. 사진은 `{ type: "photo", slot }` 이 있는 자리에 그린다     |

SVG로 옮기는 법: Figma MCP `download_assets` 로 해당 노드를 SVG로 내보낸 뒤, 내보내기가 덧붙인
회색 바탕(`#F5F5F5`)과 틀 전체 크기의 바탕 사각형을 지운다. `clipPath` 안의 사각형은 지우지 않는다.
비어 있는 `clipPath` 는 그림 전체를 가린다. `tests/unit/frames.test.ts` 가 두 가지 모두 검사한다.
위치는 내보낸 파일의 `translate(-x -y)` 값이다.

주의할 점:

- **사진 칸은 4:3** 이어야 한다(`KIOSK_CONFIG.captureAspect`). 미리보기와 결과가 같은 비율이어야 해서,
  다르면 `tests/unit/frames.test.ts` 가 실패한다.
- **글자 위치:** 코드는 글자의 기준선(baseline)에 y를 둔다. Figma 텍스트 상자의 위쪽 y에
  `글자 크기 × 0.88` 을 더한 값이 코드의 y다. 가운데 정렬 글자의 x는 프레임 폭의 절반이다.
- **날짜:** `{date}` 는 촬영일(한국 시간, `2026.12.24` 꼴)로 바뀐다. 지금 틀 A~D는 쓰지 않는다.

### 로고 규칙 (코드가 검사함)

`tests/unit/frames.test.ts` 가 모든 프레임에 대해 확인한다. 하나라도 어기면 `npm run check` 가 실패한다.

- 프레임마다 `brand` 표시가 된 락업 그림이 하나 있다.
- 출력 폭의 38% 이상, 높이 80px 이상(600×1800 기준). 예전 한 줄 워드마크는 폭 55%였다. 네 줄로 쌓은
  락업은 같은 글자 높이에 폭이 덜 필요하다(높이 80px이면 SHALOM 대문자가 약 32px, 예전 글자는 약 30px).
- SVG의 비율(422×156.13) 그대로, 틀의 가운데에 그린다(`config/frames/shared.ts` 의 `lockupBox`).
- 글자는 윤곽선(path)이다. `<text>` 나 글꼴 이름이 있으면 실패한다(캔버스에는 웹 글꼴이 없다).
- 사진 칸보다 아래에 있다(얼굴을 가리지 않게).
- 바탕색과 대비 4.5:1 이상.

### 락업 SVG 만드는 법

`public/frames/{navy,wood,cream}-lockup.svg` 는 Figma에서 내보낸 것이 아니라, 함께 배포하는 글꼴 파일
(`node_modules/@fontsource/cormorant-garamond/files/cormorant-garamond-latin-{500,600}-normal.woff`,
`node_modules/@fontsource/nanum-myeongjo/files/nanum-myeongjo-korean-400-normal.woff`)에서 opentype.js로
글자 윤곽선을 뽑아 만들었다(2026-11-11, 일회용 스크립트, 저장소에 없음). SHALOM 글자 크기를 100으로 두면
STUDIO 30(자간 0.4em), 구분선 44×1.6, 평화의 벽 24(자간 0.3em), 줄 사이 13·17·17 이다. 색은 틀마다 예전
락업의 색을 그대로 쓴다: navy·wood 는 글자 `#F2C14E` + 구분선 `#FFE3A3`, cream 은 `#0B1026` + `#E8A33D`.
미디어월 그림(`public/wall/background-v3.jpg`) 아래쪽의 워드마크도 같은 락업(금색, 높이 약 103px)으로
바꿔 그렸다. 나머지 그림은 그대로다.

## 새 프레임을 추가하려면

1. Figma `STUDIO SHALOM · Frame, Phone & Wall` 에서 기존 틀을 복제해 고친다.
2. `config/frames/` 에 새 파일을 만들고 위 표대로 값을 옮긴다. `config/frames/index.ts` 의 `FRAMES` 에 넣는다.
3. `npm run check` (프레임 규칙과 로고 규칙), `npm run test:e2e` 를 돌린다.
4. 부스에서 `/kiosk?camera=mock` 으로 촬영해 결과를 눈으로 확인한다.

## 글꼴 라이선스

Noto Sans KR, Cormorant Garamond, 나눔명조는 모두 SIL Open Font License 1.1 이다. 인쇄물·앱·이미지에
자유롭게 쓸 수 있고, 글꼴 파일을 함께 배포해도 된다(`node_modules/@fontsource-variable/noto-sans-kr/LICENSE`,
`node_modules/@fontsource/cormorant-garamond/LICENSE`, `node_modules/@fontsource/nanum-myeongjo/LICENSE`).
틀의 "Christmas Village 2026"·"Jeju, 11 pm" 제목에 쓴 Fraunces와 Caveat도 OFL 1.1이고, 윤곽선으로 바꾼 SVG만
배포한다.
