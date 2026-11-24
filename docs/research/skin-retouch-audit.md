# 피부 보정 감사 · 진단 (2026-11-24)

코드와 공식 문서를 읽고 적었다. 표기: **[검증]** 직접 읽었거나 이 컨테이너에서 실행해 확인 · **[추정]** 근거에서 미루어
봄 · **[미검증]** 확인하지 못함. **iPad mini 4 실기기에서는 아무것도 돌려 보지 않았다.**

## 1. 지금 코드는 어떻게 생겼나 (기준 커밋 `0a0ad83`, main)

| 항목                | 사실                                                                                                                                                                        | 근거                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 촬영                | 6장. 카운트다운 뒤 `CameraProvider.capture` → `grabFrame` 이 4:3으로 가운데 자르고 좌우 반전해 **캔버스 한 장**으로 돌려준다                                                | `lib/camera/capture.ts`, `components/kiosk/kiosk-app.tsx` 캡처 효과   |
| 캡처 해상도         | 일반 기기 1600 × 1200. iPad mini 4(iPadOS 15 예산) **960 × 720**                                                                                                            | `lib/kiosk/legacy-ios.ts` `LEGACY_IOS15_RENDER_BUDGET`                |
| 합성 위치           | **클라이언트.** 사진을 고르면(`CONFIRM_SELECTION`) 동의·QR 화면으로 넘어가면서 `composeFrame` 이 고른 사진만 틀에 넣는다. 출력은 일반 1200 × 3600, iPad mini 4는 600 × 1800 | `kiosk-app.tsx` 「Final composite」 효과, `lib/compositor/compose.ts` |
| 흑백·세피아 등 톤   | 합성 안에서 픽셀 연산(`lib/compositor/tone.ts`). 사진이 틀의 칸에 그려질 때 걸린다                                                                                          | `compose.ts` `tonedPhoto`                                             |
| 저장·업로드         | 합성된 JPEG 한 장만 IndexedDB 큐를 거쳐 `/api/photos` 로 올라간다. **낱장 원본은 서버로 가지 않는다**                                                                       | `kiosk-app.tsx` `deliver`, `lib/offline`                              |
| 얼굴 관련 기존 코드 | **없다.** 얼굴 검출·랜드마크·보정 코드가 리포에 없었다                                                                                                                      | `lib`, `components`, `app`, `config` 전체 검색                        |
| AI 1차 필터(D95)    | 서버 쪽 일이다. 손님이 미디어월에 동의한 사진을 서버가 칸별로 잘라 공급자에게 보낸다. 얼굴 인식이 아니라 내용 분류이고, 이 작업은 건드리지 않았다                           | `lib/moderation`, `CLAUDE.md`                                         |
| iPad mini 4 경로    | Next 16은 Safari 16.4 이상만 지원해서, iPadOS 15는 Vite로 따로 구운 묶음(`legacy-kiosk/`, 대상 `safari15`)을 받는다. **같은 `KioskApp` 컴포넌트**다                         | `docs/IPAD_MINI4_COMPAT.md`, `legacy-kiosk/vite.config.mts`           |
| 메모리 관행         | iPadOS 15 경로는 합성이 끝나면 촬영 캔버스를 `width = height = 0` 으로 바로 돌려준다                                                                                        | `kiosk-app.tsx` `releaseCanvases`                                     |

원본이 서버로 올라가는 흐름은 **없다**(합성본만 올라간다). 바꾼 것도 없다.

### 훅 자리

「촬영 완료 → [피부 보정] → [색감 필터] → 틀 합성」에 맞는 자리는 한 곳뿐이다: 최종 합성 효과에서 `composeFrame` 을
부르기 직전. 거기서는 손님이 **고른 사진만**(틀에 따라 1~4장) 있으므로 6장 전부를 보정하지 않아도 된다.
`lib/kiosk/photo-stages.ts` 가 그 순서를 정의하고, 색감 필터 칸은 비워 두었다(§7).

## 2. iPad mini 4 · Safari 15에서 무엇이 되나

기기: A8, 전면 카메라 1.2 MP / 720p [검증: Apple 기술 사양, T8]. RAM 2 GB, GPU PowerVR GX6450 [검증: 위키백과만.
Apple은 RAM을 공개하지 않는다, T10]. 마지막 OS는 iPadOS 15.8.8(2026-05-11) [검증: Apple 보안 업데이트 목록, T9].

| 기능                          | Safari 15 (iPadOS 15.8)                                                                    | 상태                                    | 출처          |
| ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- | ------------- |
| WebGL 1                       | 지원 (iOS Safari 8부터)                                                                    | [검증] 문서                             | T14           |
| WebGL 2                       | Safari 15에서 출시, Metal 위의 ANGLE                                                       | [검증] 문서                             | T1, T2, T3    |
| WebAssembly                   | 지원. 15에서 스트리밍 컴파일, bulk memory, reference types, non-trapping float-to-int 추가 | [검증] 문서                             | T1, T14       |
| **WebAssembly SIMD**          | **없음.** 16.4에서 들어왔다                                                                | [검증] 문서                             | T5, T14, T16  |
| WASM 스레드                   | 15.2부터, COOP/COEP로 교차 출처 격리된 페이지에서만. 우리는 쓰지 않는다                    | [검증] 문서                             | T4            |
| OffscreenCanvas               | 없음 (2D는 16.4, WebGL은 17.0)                                                             | [검증] 문서                             | T5, T6        |
| `ctx.filter`                  | 없음 (리포 규칙과 같다)                                                                    | [검증] 문서                             | T14, T15      |
| WebGPU                        | 없음                                                                                       | [검증] 문서                             | T14           |
| 하프 플로트 렌더 타깃         | 브라우저 수준에서는 지원 표기. A8 자체의 확장 목록은 확인 못 함                            | **[미검증]** (A8)                       | T11, T14, T17 |
| 최대 텍스처 크기              | 8192 예상 (Metal Apple2 계열, ANGLE Metal 백엔드)                                          | [추정]                                  | T11, T12      |
| 캔버스 한도                   | 한 장 4096 × 4096 px, 전체 캔버스 메모리 RAM의 1/4(2 GB면 약 500 MB)                       | [검증] Safari 15 소스 / 500 MB는 [추정] | T13           |
| 위 전부를 **실기기에서** 확인 |                                                                                            | **[미검증]**                            |               |

설계에 주는 결론: 필터는 **WebGL 1 + RGBA8 타깃만** 쓴다. 하프 플로트 확장에 기대지 않는다(A8에서 미검증이므로).
SIMD가 없으니 얼굴 검출 추론이 가장 비싼 단계가 된다.

## 3. MediaPipe Face Landmarker가 이 기기에서 도는가

### 3.1 확인한 것

| 사실                                                                                                                                                     | 상태                                | 출처                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------- |
| npm 최신 `@mediapipe/tasks-vision` 은 1.2.3(2026-11-11). **SIMD 전용 wasm만** 들어 있다(14.7 MB)                                                         | [검증] 꾸러미를 풀어 봄             | T22                  |
| 1.2.3의 wasm은 SIMD를 끄면 검증에 실패한다                                                                                                               | [검증] 이 컨테이너에서 wabt로       | 로컬                 |
| non-SIMD 빌드는 2026-10-28 커밋에서 빠졌다. 관리자: "1.2.3 ships only the SIMD WASM build, so it needs iOS 16.4 or later"                                | [검증] 저장소·이슈                  | T25, T26, T27(#6139) |
| non-SIMD 빌드가 들어 있는 버전: 0.10.3 ~ 0.10.34, 1.2.0까지 [검증: 0.10.3, 0.10.14, 0.10.21, 0.10.34, 1.2.0 꾸러미]                                      | [검증]                              | T22                  |
| **0.10.21 non-SIMD wasm(9.45 MB)이 MVP 밖에서 요구하는 기능은 sign-extension 하나**                                                                      | [검증] wabt 기능 플래그를 하나씩 끔 | 로컬                 |
| 0.10.34와 1.2.0의 non-SIMD wasm은 여기에 bulk memory와 non-trapping float-to-int가 더 필요하다(Safari 15.1에 있음)                                       | [검증] wabt                         | 로컬, T1             |
| 0.10.21의 로더(`vision_wasm_nosimd_internal.js`)와 묶음(`vision_bundle.mjs`)은 **ES2021 문법으로 파싱된다**                                              | [검증] acorn                        | 로컬                 |
| 0.10.21 묶음은 OffscreenCanvas가 없거나 Safari 17 미만이면 DOM 캔버스로 넘어가고, `webgl2` → `webgl` 순으로 컨텍스트를 구한다                            | [검증] 묶음 코드                    | 로컬                 |
| CPU 델리게이트여도 **WebGL 컨텍스트가 필요**하다                                                                                                         | [검증] 이슈 #5609                   | T27                  |
| 모델: `face_landmarker.task` 3.76 MB(BlazeFace 근거리 + 랜드마크 256 × 256 + 블렌드셰이프), `blaze_face_short_range.tflite` 0.23 MB                      | [검증] 내려받아 크기 확인           | T29                  |
| Face Landmarker는 **항상 근거리 검출기**를 쓴다. 근거리 모델은 입력 128 × 128, 약 2 m 이내용이고, 평가 데이터는 얼굴이 이미지 변의 20 % 이상인 것만 썼다 | [검증] 모델 카드                    | T19, T30, T31        |
| 원거리 모델(`blaze_face_full_range`, 입력 192, 얼굴이 변의 5 % 이상)은 Face Detector로 쓸 수 있어 보인다                                                 | [추정] 그래프 코드. 실행은 안 함    | T20, T28             |
| 공식 지원 브라우저 문구: "Modern browser with WebAssembly support (Chrome, Edge, Safari, or Firefox…)". Safari 최소 버전은 없다                          | [검증] 설정 안내                    | T18                  |

### 3.2 알려진 iOS 문제 (이슈 페이지를 읽음)

- #5036: FaceDetector를 만들었다 닫기를 되풀이하면 WebKit에서 메모리가 불어나 죽는다. 관리자 답: "You should have
  a single FaceDetector instance". → 우리는 **한 번 만들어 페이지가 사는 동안 쓴다.**
- #5609: iOS 16.4/16.6에서 CPU 델리게이트인데 `kGpuService` 실패. 해결책은 옵션에 `canvas` 를 직접 넘기는 것.
  → 넘긴다.
- #5768: 0.10.18에서 Face Landmarker를 **자체 호스팅하면 iOS 16 미만에서 실패**, CDN에서는 됨. 원인은 밝혀지지 않았다.
  → **우리 구성과 같은 조건이라 가장 큰 위험이다.** 실기기에서 첫 번째로 확인할 것.
- #4604: iOS 14~16 실패(0.10.1), 2023-09에 고쳐졌다고 함.
- iPad mini 4나 A8에 특정한 이슈는 찾지 못했다.

### 3.3 판단

**「못 돈다」고 볼 근거는 없고, 「돈다」고 볼 근거도 없다. [미검증]**

- 돌 가능성을 높이는 것: non-SIMD 바이너리가 Safari 15의 기능만 요구함, 문법이 ES2021, DOM 캔버스 대체 경로가 있음,
  WebGL 2가 있음.
- 못 돌 수 있는 이유: #5768(자체 호스팅 + iOS 16 미만), 9.45 MB wasm의 컴파일 시간과 메모리(A8, 2 GB), SIMD 없는
  추론 속도.

그래서 이렇게 했다:

1. **0.10.21로 고정**하고 non-SIMD wasm 하나만 싣는다(모든 기기가 같은 바이너리). 최신 버전을 쓰지 않는 이유는 위
   표가 전부다. 요구 기능이 가장 적고(sign-extension뿐), 가장 작고, 문법이 가장 낮다. 1.2.0은 0.10.21이 실기기에서
   실패할 때 시도할 두 번째 후보다.
2. 검출기를 **인터페이스 뒤에** 두었다(`lib/retouch/detector.ts` `FaceFinder`). 초기화가 실패하면 보정 없이 사진이
   그대로 나가고, 콘솔과 서버 로그에 사유가 남는다.
3. **가벼운 모드를 같이 구현**했다(`detection.model: "detector"`): Face Detector만 돌려 6점(눈·코·입·귀)에서 마스크를
   타원으로 만든다. 사진 한 장에 추론 1번(랜드마크 모드는 1 + 얼굴 수). 실기기에서 랜드마크 모드가 느리면 설정 한 줄로
   바꾼다.

### 3.4 단체사진의 작은 얼굴 (이 컨테이너에서 실행해 확인)

근거리 검출기는 사진 전체를 128 × 128로 줄여서 보기 때문에 작은 얼굴을 놓친다. 데스크톱 Chromium에서 잰 것:

| 조건                                                               | 사진 전체 한 번      | + 2 × 2 타일(각 60 %) | + 3 × 3 타일(각 40~50 %)                 |
| ------------------------------------------------------------------ | -------------------- | --------------------- | ---------------------------------------- |
| 얼굴 6개, 각 사진 폭의 약 9 % (합성 콜라주)                        | 6개 중 4개           | 6개 중 6개            | 재지 않음                                |
| 얼굴 6개, 각 약 6 % (합성 콜라주, 1600 px)                         | 0개                  | 6개                   | 재지 않음                                |
| 7명 단체사진(`group-7`), 얼굴 약 6 %, 1600 px                      | 재지 않음            | 7명 중 4명            | 「얼굴」 8~9개(7명인데: 중복이나 오검출) |
| 원거리 모델 `blaze_face_full_range.tflite` 를 Face Detector에 넣음 | **실행 거부** (아래) |                       |                                          |

- 원거리 모델은 0.10.21의 Face Detector에서 `raw_box_tensor->shape().dims[1] == num_boxes_ (2304 vs. 896)` 로 실패한다
  [검증: 실행]. §3.1의 「쓸 수 있어 보인다」는 최신 소스 기준이고, 고정한 버전에서는 안 된다.
- 그래서 **2 × 2 타일**(6점 검출기를 겹치는 타일 네 장에 한 번씩 더)을 기본으로 넣었다(`detection.tileGrid`). 3 × 3은
  더 찾지만 오검출이 늘고 검출 횟수가 9번 더해져서 기본으로 쓰지 않는다.
- 타일로도 사진 폭의 6 % 근처 얼굴은 들쭉날쭉하게 찾는다. 그래서 **보정 강도를 그 구간에서 0으로 줄였다**
  (`face.minWidthShare` 6 % → `fullWidthShare` 9 %). 찾은 얼굴만 티 나게 보정되고 옆 얼굴은 그대로인 사진이 나오지 않는다.
- 한 장에 6명까지만 보정한다(요구 사항). 7명째부터는 작은 얼굴 순으로 그대로 둔다.

### 3.5 MediaPipe가 아예 초기화되지 않을 때의 대안 (구현하지 않음, 비교만)

| 대안                           | 라이선스   | 크기                                 | 장점                       | 걸리는 점                                                                                               | 판단                                              |
| ------------------------------ | ---------- | ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| pico.js                        | MIT        | JS 5.6 KB + 캐스케이드 240 KB        | 순수 JS, wasm·WebGL 불필요 | 2021년 이후 갱신 없음. 원 저자: 외형 변화가 큰 대상에는 피하라. 눈·입 위치를 주지 않는다                | **1순위 대안.** 얼굴 상자 + 피부색 마스크로 갈 때 |
| 피부색만으로 마스크(검출 없음) | 해당 없음  | 0                                    | 가장 가볍다                | 얼굴이 아닌 살색(나무 벽, 손, 팔)까지 건드림. 얼굴 크기를 몰라 반경을 못 맞춤. 피부톤·조명에 취약       | 단독으로는 쓰지 않는다                            |
| tracking.js (Viola-Jones)      | BSD        | 28 KB + 182 KB                       | 순수 JS                    | 2016년 이후 갱신 없음                                                                                   | pico.js보다 나을 이유 없음                        |
| face-api.js                    | MIT        | 664 KB + 193 KB                      | 작은 검출기 있음           | tfjs-core 1.7 의존, 2020년 이후 갱신 없음. **얼굴 인식 라이브러리**라 「얼굴 인식 없음」 규칙과 안 맞음 | 제외                                              |
| jeelizFaceFilter               | Apache-2.0 | 112 KB + 신경망 0.25~3.8 MB          | WebGL 기반, 얼굴 8개까지   | 영상 스트림용. 정지 사진 사용은 [미검증]. WebGL 1에서는 플로트 텍스처 필요(A8 미검증)                   | 2순위. 시험이 필요                                |
| OpenCV.js Haar                 | Apache-2.0 | 캐스케이드 0.5~0.9 MB + 런타임 수 MB | 검증된 방식                | 런타임이 MediaPipe만큼 무겁다. wasm의 SIMD 요구 여부 [미검증]                                           | 제외                                              |
| Shape Detection API            | 해당 없음  | 0                                    | 브라우저 내장              | Safari 15에 없다                                                                                        | 불가                                              |

출처 T33~T38. 실기기에서 MediaPipe 초기화가 실패하면 pico.js를 `FaceFinder` 구현으로 하나 더 넣는 것이 다음 수다.
그때의 마스크는 지금의 「6점 모드」보다 거칠다(눈·입 위치를 모르므로 엣지 보존에만 기댄다).

## 4. 보정 기법 선택

| 기법                           | 장점                                                             | 걸리는 점                                                                                                   | 출처 |
| ------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| 양방향(bilateral) 필터         | 엣지 보존, 8비트 타깃으로 충분                                   | 반경이 크면 O(N r²). 계단·gradient reversal                                                                 | T40  |
| 가이디드 필터                  | 선형 시간, 자기 유도 시 gradient reversal 없음                   | 평균·분산을 다뤄서 **플로트 타깃이 필요**(A8 미검증). 저자도 엣지 근처 헤일로는 남는다고 적었다             | T39  |
| 하이패스 스킨 스무딩(YUCI)     | 실시간 사례 있음(iPhone 5s 640 × 800 60 FPS)                     | 커브로 전체를 밝히는 방식이라 「톤을 건드리지 않는다」(원칙 P4)와 맞지 않음                                 | T43  |
| 주파수 분리                    | 결(고주파)과 톤(저주파)을 따로 다룸. 전문 리터칭의 표준 사고방식 | 그 자체는 필터가 아니라 틀이다                                                                              | T42  |
| 피부색 임계값(고정 YCbCr 범위) | 간단                                                             | "achieving skin-tone consistency in different lighting, different ethnicity … is a highly challenging task" | T45  |

고른 것: **엣지 정지 à-trous 웨이블릿**(Dammertz 외 2010, 5 × 5 B3 스플라인을 간격을 늘려 가며 4번)으로 얼굴을 크기별
띠로 나누고, 띠마다 덜어낼 비율을 따로 준다. 양방향 필터 계열이라 **RGBA8 타깃만으로** 돌고, 주파수 분리가 그대로
나온다(띠 = 이웃한 두 단계의 차). 가장 고운 띠는 건드리지 않는다. 피부색은 고정 범위 대신 **얼굴마다 그 얼굴의 중앙값과
퍼짐**으로 판정한다. (Dammertz 논문 원문은 이 세션에서 열지 않았다. 알고리즘은 널리 알려진 형태로 구현했고 인용만 한다.)

보정 반경은 사진 크기가 아니라 **얼굴 폭**에 묶었다: 얼굴마다 폭 약 128 px이 되도록 정수 배로 줄여서 계산하고,
보정값만 원본 해상도에 얹는다. 그래서 단체사진의 작은 얼굴과 독사진의 큰 얼굴이 같은 비율로 처리된다.

### 엔진 두 개

- **WebGL 1** (`lib/retouch/gl.ts`, 기본): 셰이더 5개, 전부 RGBA8, 확장 없음.
- **타입 배열** (`lib/retouch/cpu.ts`): 같은 산수의 기준 구현. 단위 시험이 이것으로 돌고, WebGL을 못 쓰면 대신 돈다.

필터 자체는 얼굴 하나당 작업 이미지가 200 × 260 px 안팎이라 가볍다. **시간은 검출이 먹는다** [추정: SIMD 없는 wasm
추론. 실기기 수치 없음].

## 5. 이 컨테이너에서 실행해 확인한 것 (데스크톱 Chromium. iPad가 아니다)

- 자체 호스팅한 non-SIMD wasm과 모델이 헤드리스 Chromium에서 올라가고 얼굴을 찾는다. `.wasm` 은
  `application/wasm` 으로 나간다(Next 개발 서버와 프로덕션 서버).
- WebGL 엔진과 CPU 엔진의 결과가 같다: 샘플 3장 × 2단계에서 가장 큰 차이 6단계 이하, 2단계를 넘는 픽셀 0.1 % 미만
  (`e2e/retouch.spec.ts`).
- 샘플 15장 × 2단계(960 × 720, CPU 엔진)에서 얼굴 밖 픽셀 변경은 전부 0이다. 15장 중 13장에서 얼굴이 보정됐고
  (단체 두 장은 얼굴이 작아 건너뜀), 그 13장의 범위는(§5.1에서 정한 수치 기준): 고운 결 유지 자연스럽게
  94.5~100 % / 뽀샤시 90.8~98.4 %, 채도 자연스럽게 98.7~99.7 % / 뽀샤시 100.9~102.4 %, 평균 밝기 변화
  자연스럽게 −1.0~0 단계 / 뽀샤시 +1.7~+3.5 단계(0~255), 평균 픽셀 변화 자연스럽게 0.9~2.5 단계 / 뽀샤시
  2.3~4.1 단계, 가장 큰 픽셀 변화 자연스럽게 6~14 단계 / 뽀샤시 11~24 단계. 수치 전체는
  `tests/fixtures/skin-retouch/baseline.json`, 그림은 `docs/screenshots/skin-retouch/`.
- 어두운 피부 샘플에서 처음에는 붉은기 완화가 얼굴 절반에서 빨강을 빼고 있었다(평균 R −1.1단계, 채도 −1.8 %).
  「그 얼굴의 색에서 튀는 곳만」으로 바꾼 뒤 R −0.5단계, 채도 −1.0 %가 됐다(`filter.rednessSigmas`).
- 부스 흐름: 가짜 웹캠으로 얼굴을 찍어 촬영 → 「현상 중…」 → 보정(4장 모두 1/1) → 합성 1200 × 3600 → QR까지 간다
  (`e2e/retouch-camera.spec.ts`). 모델을 막으면 보정 없이 QR까지 가고, 콘솔과 하트비트에 `init-failed` 가 남는다.
- 처리 시간(이 컨테이너의 CPU, 소프트웨어 WebGL. **참고용이고 iPad 수치가 아니다**): 960 × 720 한 장에 검출
  100~250 ms, 보정 50~200 ms.

### 5.1 강도 결정 (2026-11-24, 사용자가 맡김: 「강도 결정도 너가 일단 해줘」)

정한 사람은 Claude다. 근거는 샘플 15장을 후보별로 나란히 놓은 얼굴 확대 시트(960 × 720, CPU 엔진, 데스크톱
Chromium)와 그 수치다. **사람이 비교 페이지와 iPad mini 4 화면에서 확인한 적은 없다.**

|                                          | 처음 수치                  | 정한 수치                      |
| ---------------------------------------- | -------------------------- | ------------------------------ |
| 자연스럽게 띠별 제거(1.6 / 3 / 6 / 12 %) | 30 / 55 / 50 / 15 %        | **42 / 75 / 70 / 20 %**        |
| 자연스럽게 눈 밑 · 붉은기                | 25 % · 20 %                | **30 % · 25 %**                |
| 자연스럽게 가장 고운 결 · 밝히기         | 0 · 0                      | 0 · 0 (그대로)                 |
| 뽀샤시 띠별 제거                         | 55 / 80 / 70 / 25 %        | **60 / 85 / 75 / 25 %**        |
| 뽀샤시 `keepAbove`                       | 0.045 / 0.065 / 0.08 / 0.1 | **0.04 / 0.055 / 0.07 / 0.09** |
| 뽀샤시 가장 고운 결                      | 12 %                       | **10 %**                       |
| 뽀샤시 눈 밑 · 붉은기 · 밝히기           | 40 % · 35 % · 3.5 %        | 그대로                         |

본 것과 판단:

- **자연스럽게는 약 1.4배로 올렸다.** 처음 수치는 확대 시트에서 원본과 구별이 거의 안 됐다(0.7배 · 1배 · 1.5배,
  그리고 띠를 따로 잡은 후보 셋을 비교). 1.5배까지 올려도 주름, 점, 주근깨, 수염 자국, 안경테가 남아 있었다:
  큰 편차는 `keepAbove` 가 지키기 때문이다. 가장 넓은 띠(얼굴 폭의 12 %)는 20 %에서 멈췄다. 얼굴의 입체감을 만드는
  음영이 거기 있다.
- **뽀샤시는 사실상 그대로다.** 1.4배에서는 볼이 밀랍처럼 되고 팔자 주름이 사라졌다(어린이 샘플도 같았다). 띠는
  자연스럽게보다 모든 띠에서 높게만 맞췄고, 그만큼 `keepAbove` 를 조금 내려 주름의 모양이 남게 했다. 결과 수치는
  처음과 거의 같다(예: 동아시아 여성 샘플 평균 픽셀 변화 3.21 → 3.25, 고운 결 94.0 → 95.2 %).
- **밝히기는 올리지 않았다.** 0.045와 0.05를 재 보니 강한 조명 샘플 두 장(older-woman, glasses-man)에서 날아간
  하이라이트 픽셀이 `e2e/retouch.spec.ts` 의 한계를 넘었다(0.05에서 1943 → 2881, 6399 → 9129. 한계는 각각 2531,
  7878). 밝히기의 감쇠가 밝기(luma)를 보는데 피부에서는 빨강 채널이 먼저 날아가기 때문이다. 더 밝은 뽀샤시를
  원하면 감쇠를 가장 밝은 채널 기준으로 바꿔야 한다(두 엔진의 산수를 바꾸는 일이라 이번에 하지 않았다).
- 결이 강한 얼굴: 단위 시험의 합성 얼굴에서 강한 무늬의 제거 몫이 8.6 % → 11.1 %가 됐다(옅은 무늬는 14.6 %로
  그대로: 몇 단계짜리 무늬라 8비트 계단에 묶인다). 그 시험의 비율 한계를 0.7 → 0.8로 바꾸고 제거 몫 자체의
  한계(12.5 % 미만)를 더했다. 실제 샘플(주름 많은 얼굴)에서는 고운 결 유지 99.1 %이고, 확대 시트에서 주름과
  모공이 그대로였다.

한계: 샘플은 스튜디오 사진이 대부분이다. 부스의 iPad mini 4 전면 카메라 사진(작은 센서, 저녁 실내 조명, 노이즈)은
한 장도 없다. 여드름처럼 붉고 도드라진 잡티, 수염, 진한 화장도 없다. 이 수치는 그 사진들로 다시 봐야 한다.

## 6. 위험과 실기기에서 먼저 볼 것

1. MediaPipe 0.10.21 non-SIMD가 iPadOS 15.8에서 초기화되는가 (#5768).
2. 초기화 시간과 그 뒤의 메모리. 탭이 다시 로드되는가.
3. 사진 한 장의 검출 시간(랜드마크 모드 / 6점 모드).
4. WebGL 엔진이 A8에서 돌고 CPU 엔진과 같은 결과를 내는가.
5. 4장 합계가 목표(6초) 안인가.

측정 방법은 `README.md` 「피부 보정」 절.

## 7. 병행 작업과 만나는 자리

- 색감 필터(LUT) 브랜치는 main에 없다(`origin` 에 `main` 과 이 브랜치뿐). 남의 코드를 가져오지 않았다.
- `lib/kiosk/photo-stages.ts` 에 순서(`skin-retouch` → `colour-filter`)와 단계 인터페이스만 정의했다. 색감 필터는 그
  인터페이스의 구현 하나를 `kiosk-app.tsx` 의 단계 목록에 넣으면 된다.
- 지금 있는 톤(흑백·세피아·플래시·필름)은 합성 안에서 걸리므로 피부 보정 **뒤**다. 순서가 맞다.

## 8. 출처 (확인 날짜 모두 2026-11-24)

「로컬」은 이 컨테이너에서 꾸러미를 풀어 wabt(기능 플래그 검증)와 acorn(문법 파싱)으로 직접 확인한 것이다.

| #   | URL                                                                                                                              | 무엇을 뒷받침하나                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| T1  | https://webkit.org/blog/11989/new-webkit-features-in-safari-15/                                                                  | WebGL 2, Metal, Safari 15의 wasm 기능 |
| T2  | https://webkit.org/blog/11727/release-notes-for-safari-technology-preview-126-with-safari-15-features/                           | "Metal via ANGLE"                     |
| T3  | https://webkit.org/blog/11672/release-notes-for-safari-technology-preview-124/                                                   | Metal ANGLE 백엔드                    |
| T4  | https://webkit.org/blog/12140/new-webkit-features-in-safari-15-2/                                                                | COOP/COEP, 스레드                     |
| T5  | https://webkit.org/blog/13966/webkit-features-in-safari-16-4/                                                                    | wasm SIMD, OffscreenCanvas 2D         |
| T6  | https://webkit.org/blog/14445/webkit-features-in-safari-17-0/                                                                    | OffscreenCanvas WebGL                 |
| T8  | https://support.apple.com/en-us/112002                                                                                           | iPad mini 4 기술 사양                 |
| T9  | https://support.apple.com/en-us/100100                                                                                           | iPadOS 15.8.8                         |
| T10 | https://en.wikipedia.org/wiki/IPad_Mini_4                                                                                        | RAM, GPU (2차 출처)                   |
| T11 | https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf                                                                   | A8 = Apple2, 텍스처 한도              |
| T12 | https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/metal/DisplayMtl.mm                                    | 최대 텍스처 크기(현재 main 기준)      |
| T13 | https://raw.githubusercontent.com/WebKit/WebKit/safari-612-branch/Source/WebCore/html/HTMLCanvasElement.cpp                      | 캔버스 한도                           |
| T14 | https://github.com/mdn/browser-compat-data (npm `@mdn/browser-compat-data` 8.1.10)                                               | 기능별 Safari 버전                    |
| T15 | https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/filter                                                 | `ctx.filter`                          |
| T16 | https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/wasm-simd.json                                                 | wasm SIMD                             |
| T17 | https://web3dsurvey.com/webgl/parameters/MAX_TEXTURE_SIZE                                                                        | iOS 전체 집계(A8 한정 아님)           |
| T18 | https://developers.google.com/edge/mediapipe/solutions/setup_web                                                                 | 지원 브라우저                         |
| T19 | https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker?tab=Web                                            | 옵션, 모델                            |
| T20 | https://developers.google.com/edge/mediapipe/solutions/vision/face_detector?tab=Web                                              | 옵션, BlazeFace 종류                  |
| T22 | https://registry.npmjs.org/@mediapipe/tasks-vision                                                                               | 버전, 꾸러미                          |
| T25 | https://github.com/google-ai-edge/mediapipe/commit/b00327bd87f4dc44f4170771604d59dfeb3de855                                      | non-SIMD 제거 커밋                    |
| T26 | https://github.com/google-ai-edge/mediapipe/releases                                                                             | v1.2.2 릴리스 노트                    |
| T27 | https://github.com/google-ai-edge/mediapipe/issues/6139 (그리고 /5036, /5609, /5768, /4604)                                      | iOS 이슈                              |
| T28 | https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/tasks/cc/vision/face_detector/face_detector_graph.cc | 128 / 192 입력 분기                   |
| T29 | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task                   | 모델 파일                             |
| T30 | https://huggingface.co/litert-community/MediaPipe-FaceDetector-BlazeFace-Short-Range                                             | 근거리 "≈2 meters"                    |
| T31 | https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf                       | 모델 카드                             |
| T33 | https://github.com/nenadmarkus/picojs                                                                                            | pico.js                               |
| T34 | https://github.com/eduardolundgren/tracking.js                                                                                   | tracking.js                           |
| T35 | https://github.com/justadudewhohacks/face-api.js                                                                                 | face-api.js                           |
| T36 | https://github.com/jeeliz/jeelizFaceFilter                                                                                       | jeelizFaceFilter                      |
| T37 | https://registry.npmjs.org/@techstark/opencv-js                                                                                  | OpenCV.js                             |
| T38 | https://raw.githubusercontent.com/WICG/shape-detection-api/main/README.md                                                        | Shape Detection API                   |
| T39 | https://people.csail.mit.edu/kaiming/publications/pami12guidedfilter.pdf                                                         | 가이디드 필터                         |
| T40 | https://en.wikipedia.org/wiki/Bilateral_filter                                                                                   | 양방향 필터(2차 출처)                 |
| T42 | https://fstoppers.com/post-production/ultimate-guide-frequency-separation-technique-8699                                         | 주파수 분리                           |
| T43 | https://raw.githubusercontent.com/YuAo/YUCIHighPassSkinSmoothing/master/README.md                                                | 하이패스 스킨 스무딩                  |
| T45 | https://pmc.ncbi.nlm.nih.gov/articles/PMC9965146/                                                                                | 피부색 임계값의 한계(Nanni 외 2023)   |

열지 않아 인용만 한 것: Tomasi & Manduchi 1998(양방향 필터), Dammertz 외 2010(à-trous), Kakumanu 외 2007(피부색 검출
조사), Chai & Ngan 1999(YCbCr 범위. 숫자는 확인하지 못해 이 문서에 적지 않았다).
