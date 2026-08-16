# super-rockin-fun-christmas

인터랙티브 음악 설치 + 개인용 웹 경험을 위한 Product Discovery / Creative Direction 저장소.

Christmas installation은 **첫 번째 use case**일 뿐이며, 제품의 정체성이 아닙니다.

## 현재 단계

Product Discovery → Creative Direction → Figma Visual R&D → Prototype Specification
(아직 완제품 구현 단계가 아닙니다.)

## 문서

- [`docs/PRODUCT-DIRECTION.md`](docs/PRODUCT-DIRECTION.md) — 레퍼런스 해체 분석, 6개 콘셉트, 가중 스코어카드,
  최종 방향(**AFTERGLOW**), 음악 지능 모델, 협업 모델, 모션 스펙, 기술 아키텍처, Vertical Slice 정의
- [`prototypes/silent-night-conductor.html`](prototypes/silent-night-conductor.html) — 최초 인터랙션 가설 프로토타입 (원본).
  문서 4장에서 라인 단위로 분석합니다 (버그 7건 + 구조적 문제 6건, 살릴 것/버릴 것 포함)
- [`prototypes/silent-night-conductor-fixed.html`](prototypes/silent-night-conductor-fixed.html) — **버그 7건 적용한 수정본.**
  수정 지점마다 `[FIX Bn]` 주석이 있습니다. 상단 `CONFIG.INSTALL_MODE = true` 로 바꾸면
  테스트 UI와 음악 이론 표시가 한 번에 사라집니다 (현장 설치용)

### 두 파일을 비교해서 확인할 것

`http://localhost` 로 열어 번갈아 쳐 보시고 **"손을 내린 순간과 소리가 붙어 있는가"** 하나만 보세요.
이 판정이 다음 단계 전체를 가릅니다 (문서 26장).

## Figma

**[AFTERGLOW — Interactive Music Installation (Visual R&D)](https://www.figma.com/design/Tzvtju8lcgmHKIGzLigpYu)**

**Figma가 처음이시면 `00 · 먼저 여기부터 ⭐` 페이지만 보시면 됩니다.** 파일 구조, 3분 사용법,
자주 하는 작업(단축키 포함), 화면 읽는 법, 안전 규칙이 전부 그 한 장에 있습니다.

| 페이지 | 내용 |
| --- | --- |
| `00 · 먼저 여기부터 ⭐` | 사용 안내 · 화면 읽는 법 · 안전 규칙 |
| `01 · Visual Directions` | EMBER / VELLUM / AURORA 3개 방향 |
| `02 · Media Wall — States` | 8개 설치 상태 (3840×1080) |
| `03 · Aspect Ratios` | 16:9 / 21:9 / 32:9 구성 비교 |
| `04 · Personal Mode` | 랜딩 · 권한 · 플레이 · 월드선택 · 모바일 · 키프세이크 |
| `05 · Design System` | 3모드 토큰, 흑체 참가자 스케일, 타입 램프 |

## 한 줄 요약

> 당신의 움직임은 사라지지 않는다. 빛이 되어 남고, 박자에 맞춰 스스로 노래하며,
> 다른 사람의 빛과 만나 합주가 된다.
