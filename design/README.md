# 디자인 원본 (Figma) 과 코드의 연결

편집 가능한 원본은 Figma 파일 하나다.

- 파일: **FOLLOW THE LIGHTS — 디자인 원본**
  https://www.figma.com/design/S5hz7sZaXXB2kNc9YrB3cB
- 위치: 이 파일을 만든 Figma 계정(Luca Kim 팀)의 드래프트. 다른 사람이 편집하려면 파일 오른쪽 위
  Share에서 초대한다.
- 이 폴더의 `previews/*.jpg` 는 2026-10-13 기준 화면을 그대로 찍은 것이다. Figma에 들어갈 수 없을 때
  보는 참고용이고, 원본은 아니다.

Figma와 코드는 **자동으로 동기화되지 않는다.** Figma에서 바꾼 것은 아래 표의 코드 위치에 같은 값을
옮겨야 실제 부스·미디어월에 반영된다. 반대로 코드를 바꾸면 Figma도 고쳐 둔다.

## 페이지

| 페이지                | 내용                                                                                 | 미리보기                         |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| 00 표지 · 토큰 · 로고 | 색 변수(`FTL 색`), 글꼴 스타일, 로고 컴포넌트(마크·워드마크·가로형), 전구·집게·별    | `previews/00-tokens-logo.jpg`    |
| 01 네컷 프레임        | 프레임 3종 컴포넌트(실제 픽셀 크기), 25% 축소 확인                                   | `previews/01-frames.jpg`         |
| 02 미디어월           | 3840×1080·1920×1080 장면, 닫힘·잠시 멈춤·빈 줄 상태, `미디어월/걸린 사진` 컴포넌트   | `previews/02-wall-3840x1080.jpg` |
| 03 부스 화면          | 1280×800 화면 11개(시작 → 촬영 → 고르기 → QR → 동의 → 끝, QR 준비 중, 오프라인)      | `previews/03-booth.jpg`          |
| 04 관리자 화면        | 스태프 휴대폰 390×844: PIN 로그인, 개요(비상 스위치), 검수, 키오스크                 | `previews/04-admin.jpg`          |
| 05 현장 사인물        | 동선 안내 A2(방향 3종), 가로 배너, 부스 사용법 A2(그림 3단계), 사진 안내 A4, 벽 안내 | `previews/05-signage.jpg`        |

## 무엇을 바꾸면 어디를 고치나

| Figma에서 바꾼 것                    | 코드에서 고칠 곳                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 색 변수 `ink`~`pine`                 | `app/globals.css` 의 `@theme` (`--color-*`). 변수 설명에 같은 hex가 적혀 있다                             |
| 색 변수 `frame/*`                    | 해당 프레임 파일 `config/frames/*.ts`                                                                     |
| 색 변수 `wall/*`                     | `components/wall/wall-scene.tsx` (방 벽·창틀·빨랫줄·전구)                                                 |
| 글꼴                                 | 앱은 `@fontsource-variable/noto-sans-kr` 를 함께 배포한다(`app/layout.tsx`, `lib/canvas.ts` `BRAND_FONT`) |
| 네컷 프레임 (`프레임/<id>` 컴포넌트) | `config/frames/<id>.ts`. 아래 "프레임 옮기는 법"                                                          |
| 미디어월 사진 크기·개수·줄 처짐      | `config/wall.ts` 의 `scene` (`photoHeight`, `gap`, `sag` 등). 배치 계산은 `lib/wall/layout.ts`            |
| 미디어월 문구 (닫힘·잠시 멈춤·빈 줄) | `components/wall/wall-app.tsx`                                                                            |
| 부스 문구·버튼                       | `components/kiosk/kiosk-app.tsx`, 버튼 모양은 `app/globals.css` 의 `.btn-primary` / `.btn-secondary`      |
| 관리자 문구·상태 색                  | `components/admin/*`, 상태 이름과 색은 `components/admin/labels.ts`                                       |
| 사인물                               | 코드 없음. Figma에서 PDF(벡터)로 내보내 인쇄한다                                                          |

### 프레임 옮기는 법

프레임은 코드에서 데이터다(`lib/compositor/types.ts` 의 `FrameDefinition`). Figma 컴포넌트의 레이어가
그 필드와 1:1로 대응한다.

| Figma 레이어                         | `FrameDefinition` 필드                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| 컴포넌트 크기                        | `outputWidth`, `outputHeight`                                                 |
| 컴포넌트 채우기                      | `background` (단색 또는 위→아래 그라데이션)                                   |
| `사진 1`~`사진 4` 사각형             | `slots[i]`: x, y, width, height, 모서리 `radius`, 테두리 `border`             |
| `로고 (워드마크)`, `날짜 줄`, `문구` | `decorations` 의 `text`: 글자, 크기, 굵기, 색, 자간(px)                       |
| `전구 줄` 그룹                       | `decorations` 의 `lights`: 시작·끝점, 개수, 반지름, 색 목록, 전선 색          |
| `별` 그룹                            | `decorations` 의 `stars`: 영역과 `seed`. 별 하나하나의 위치는 코드가 계산한다 |

주의할 점:

- **사진 칸은 4:3** 이어야 한다(`KIOSK_CONFIG.captureAspect`). 미리보기와 결과가 같은 비율이어야 해서,
  다르면 `tests/unit/frames.test.ts` 가 실패한다.
- **글자 위치:** 코드는 글자의 기준선(baseline)에 y를 둔다. Figma 텍스트 상자의 위쪽 y에
  `글자 크기 × 0.88` 을 더한 값이 코드의 y다. 가운데 정렬 글자의 x는 프레임 폭의 절반이다.
- **굵기:** Figma의 Noto Sans KR에는 Bold(700) 다음이 Black(900)이다. 코드에는 500·700만 쓴다.
- **날짜:** `{date}` 는 촬영일(한국 시간, `2026.12.24` 꼴)로 바뀐다. Figma에는 예시 날짜가 들어 있다.

### 로고 규칙 (코드가 검사함)

`tests/unit/frames.test.ts` 가 모든 프레임에 대해 확인한다. 하나라도 어기면 `npm run check` 가 실패한다.

- 프레임마다 `FOLLOW THE LIGHTS` 워드마크가 있다.
- 굵기 700 이상.
- 글자 크기가 출력 폭의 4.5% 이상(1200 px 스트립이면 54 px 이상). 휴대폰에서 스트립 전체를 볼 때
  로고 높이가 약 16 px, 미디어월의 1400 px 사본에서 약 25 px가 된다.
- 자간이 글자 크기의 10~25%. 좁으면 작은 크기에서 획이 붙고, 넓으면 단어가 흩어진다.
- 출력 폭의 90% 안에 들어간다(대문자 평균 폭 0.72 em으로 어림).
- 사진 칸보다 아래에 있다(얼굴을 가리지 않게).
- 바탕색과 대비 4.5:1 이상(그라데이션이면 양 끝 모두).

## 새 프레임을 추가하려면

1. Figma `01 네컷 프레임` 에서 기존 프레임 컴포넌트를 복제해 고친다.
2. `config/frames/` 에 새 파일을 만들고 위 표대로 값을 옮긴다. `config/frames/index.ts` 의 `FRAMES` 에 넣는다.
3. `npm run check` (프레임 규칙과 로고 규칙), `npm run test:e2e` 를 돌린다.
4. 부스에서 `/kiosk?camera=mock` 으로 촬영해 결과를 눈으로 확인한다.

## 글꼴 라이선스

Noto Sans KR 은 SIL Open Font License 1.1 이다. 인쇄물·앱·이미지에 자유롭게 쓸 수 있고, 글꼴 파일을
함께 배포해도 된다(`node_modules/@fontsource-variable/noto-sans-kr/LICENSE`).
