# 디자인 원본 (Figma) 과 코드의 연결

편집 가능한 원본은 Figma 파일 하나다.

- 파일: https://www.figma.com/design/ZbeBrS0o5012SNFrGZNyIU (2026-10-14부터. D65)
- 이전 원본 https://www.figma.com/design/S5hz7sZaXXB2kNc9YrB3cB 은 기록으로만 둔다(D63).
- 이 폴더의 `previews/*.jpg` 는 이전 원본 기준(2026-10-13) 화면이다. 새 화면은 `docs/screenshots/` 에
  E2E가 찍는다.

Figma와 코드는 **자동으로 동기화되지 않는다.** Figma에서 바꾼 것은 아래 표의 코드 위치에 같은 값을
옮겨야 실제 부스·미디어월에 반영된다. 반대로 코드를 바꾸면 Figma도 고쳐 둔다.

## 페이지

| 페이지                      | 내용                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| 00 Foundations              | 색 변수, 글자 스타일, 로고 락업, 반짝이·집게·버튼 컴포넌트                              |
| 01 Platform — Booth & Admin | 부스 화면 01~07(시작 → 틀 → 촬영 → 확인 → 틀 다시 → 미디어월 → 사진 받기), 관리자 A0~A8 |
| 02 네컷 Templates           | 네컷 틀 A~D(남색·창틀·빨랫줄·크림, 600×1800). E~J는 후보안이라 코드에 없다              |

## 무엇을 바꾸면 어디를 고치나

| Figma에서 바꾼 것                    | 코드에서 고칠 곳                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 색 변수 `ink`~`pine`                 | `app/globals.css` 의 `@theme` (`--color-*`). 변수 설명에 같은 hex가 적혀 있다                             |
| 색 변수 `frame/*`                    | 해당 프레임 파일 `config/frames/*.ts`                                                                     |
| 색 변수 `wall/*`                     | `components/wall/wall-scene.tsx` (방 벽·창틀·빨랫줄·전구)                                                 |
| 글꼴                                 | 앱은 `@fontsource-variable/noto-sans-kr` 를 함께 배포한다(`app/layout.tsx`, `lib/canvas.ts` `BRAND_FONT`) |
| 네컷 틀 (`Template/A`~`D`)           | `config/frames/<id>.ts` 와 `public/frames/*.svg`. 아래 "프레임 옮기는 법"                                 |
| 미디어월 사진 크기·개수·줄 처짐      | `config/wall.ts` 의 `scene` (`photoHeight`, `gap`, `sag` 등). 배치 계산은 `lib/wall/layout.ts`            |
| 미디어월 문구 (닫힘·잠시 멈춤·빈 줄) | `components/wall/wall-app.tsx`                                                                            |
| 부스 문구·버튼                       | `components/kiosk/kiosk-app.tsx`, 버튼·배경·글자 크기는 `app/globals.css` 의 `.booth-*`                   |
| 관리자 문구·상태 색                  | `components/admin/*`, 상태 이름과 색은 `components/admin/labels.ts`                                       |
| 사인물                               | 코드 없음. Figma에서 PDF(벡터)로 내보내 인쇄한다                                                          |

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

- 프레임마다 `brand` 표시가 된 워드마크 그림이 하나 있다.
- 출력 폭의 55% 이상.
- 사진 칸보다 아래에 있다(얼굴을 가리지 않게).
- 바탕색과 대비 4.5:1 이상.

## 새 프레임을 추가하려면

1. Figma `02 네컷 Templates` 에서 기존 틀 컴포넌트를 복제해 고친다.
2. `config/frames/` 에 새 파일을 만들고 위 표대로 값을 옮긴다. `config/frames/index.ts` 의 `FRAMES` 에 넣는다.
3. `npm run check` (프레임 규칙과 로고 규칙), `npm run test:e2e` 를 돌린다.
4. 부스에서 `/kiosk?camera=mock` 으로 촬영해 결과를 눈으로 확인한다.

## 글꼴 라이선스

Noto Sans KR 은 SIL Open Font License 1.1 이다. 인쇄물·앱·이미지에 자유롭게 쓸 수 있고, 글꼴 파일을
함께 배포해도 된다(`node_modules/@fontsource-variable/noto-sans-kr/LICENSE`). 틀의 영문 로고·제목에 쓴
Fraunces와 Caveat도 OFL 1.1이다. 글꼴 파일이 아니라 윤곽선으로 바꾼 SVG만 배포한다.
