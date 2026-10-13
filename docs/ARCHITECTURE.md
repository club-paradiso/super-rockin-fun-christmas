# Architecture

이 문서는 두 부분이다.

1. **목표 구조 (Phase 1 설계, 2026-10-12).** 현장 우선(local-first)으로 바꾸는 설계. 아직 구현 전이다.
   항목마다 상태를 적는다.
2. **현재 구현 (Phase 1~4, 클라우드 기준).** 지금 코드가 실제로 하는 일. 목표 구조로 옮길 때 재사용하는
   부품의 설명서다.

---

# 1부. 목표 구조 (Phase 1 설계)

## 1.1 확정된 사실과 가정

| 구분          | 내용                                                                                                                                                | 출처                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 사실          | 출력하지 않는다. 사진은 QR로 손님 휴대폰에 간다                                                                                                     | 2026-10-12 답변 Q1                                           |
| 사실          | 미디어월은 LED. 하루 종일 켜두지 않고 담당자와 정한 시간에만 튼다                                                                                   | 답변 Q2, Q4                                                  |
| 사실          | 부스는 웹캠 + 모니터, 또는 빌린 노트북·태블릿. 조명은 저가 구매 가능                                                                                | 답변 Q5                                                      |
| 사실          | 와이파이 품질은 나쁘지 않음. 유선은 아마 가능. 한 공유기로 묶을 수 있는지는 모름                                                                    | 답변 Q6                                                      |
| 사실          | 상주 인력 1~2명                                                                                                                                     | 답변 Q8                                                      |
| 사실          | 예산 상한 50만원 (장비 + 클라우드 합계로 해석)                                                                                                      | 답변 Q10                                                     |
| 사실          | 디자인은 Figma에서 편집 가능해야 한다                                                                                                               | 답변 Q11                                                     |
| 사실          | 개인정보 기준은 교회와 논의 중                                                                                                                      | 답변 Q9                                                      |
| 사실 (기획안) | 제주성안교회 Christmas Village 2026. 제안 운영 기간 2026-11-28 ~ 2027-01 둘째 주. 하루 운영 시간 미정                                               | 2026-10-07 기획안 세션 (`Follow_the_Lights_제품명세.md` 6장) |
| 사실 (기획안) | 처리량 계획값: 부스당 시간당 20그룹, 그룹당 최대 6명, 그룹 1개 = 촬영 1건                                                                           | 같은 명세 6장                                                |
| 사실 (기획안) | 제안 일정: 10/23 실제 카메라 → QR 검증, 11/9~13 LED 실공간 시험, 11/21~27 동결, 11/28 개장. 개장 1주 전부터 새 기능 없음                            | 같은 명세 16장                                               |
| 사실 (기획안) | 개인정보 제안값: QR 24시간, 게시 안 한 사진 24시간, 게시 사진은 행사 종료 후 24시간 안에 파기, 14세 미만은 법정대리인 동의. **교회 확인 전 제안값** | 같은 명세 10장                                               |
| 사실 (기획안) | 목표: 첫 노출 95%가 승인 후 90초 이내, 숨김 반영 5초 이내                                                                                           | 같은 명세                                                    |
| 추정          | 행사 전체 촬영 최대 약 5,000건 (부스 1대 × 시간당 20건 × 하루 6시간 × 약 44일). 부하 시험 기준으로 쓴다                                             | 위 계획값에서 계산                                           |
| 가정          | LED 입력 해상도 미정. 레이아웃은 해상도 설정값으로 그리고 확정하지 않는다                                                                           | 멈춤 조건                                                    |
| 가정          | 허브는 빌린 노트북 1대 (Windows 또는 macOS, Chrome 설치 가능)                                                                                       | 답변 Q5, Q10에서 추정                                        |
| 가정          | 부스·벽·허브용 전용 공유기 1대를 둔다 (교회 공용 와이파이와 분리)                                                                                   | 보안 권장, 예산 안                                           |

## 1.2 한 장 요약

```
                 ┌──────────── 현장 전용 LAN (공유기 1대, 비밀번호는 스태프만) ────────────┐
 [부스 노트북]                                                                         │
  Chrome 전체화면 ── http://localhost:3000/kiosk ─┐                                    │
  웹캠 + 조명       (허브가 이 노트북에서 돈다)    │                                    │
                                                  ▼                                    │
                              ┌──────── 허브 = 이 Next.js 앱 (`FTL_ROLE=hub`) ───────┐ │
                              │ 사진·DB: 노트북 디스크 (.data/)  ← 기준 저장소        │ │
                              │ 검수·감사·비상 스위치·벽 피드·노출 기록               │ │
                              │ 백업: USB 디스크로 주기 복사                          │ │
                              │ 클라우드 동기화 큐 ───────────────┐                   │ │
                              └──────────────────────────────────┼───────────────────┘ │
 [미디어월 PC → LED]  http://<허브 주소>:3000/wall ◄─ LAN         │                     │
 [스태프 휴대폰]      http://<허브 주소>:3000/admin ◄─ LAN (PIN)   │                     │
                 └────────────────────────────────────────────────┼─────────────────────┘
                                                                  │ 인터넷 (되면)
                                                                  ▼
                       Vercel (`FTL_ROLE=cloud`): /api/hub/* (허브 전용 비밀값) · /p/[token]
                       Supabase: 사진 사본 + 토큰 해시만. 동의·검수 정보 없음
                                                                  ▲
 [손님 휴대폰 (셀룰러)] ── QR ── https://<공개 주소>/p/<token> ────┘
```

핵심은 세 가지다.

- **기준 저장소는 현장 허브다.** 촬영, 동의, 검수, 벽 노출, 비상 스위치는 인터넷 없이 돈다.
- **클라우드는 QR 다운로드용 사본이다.** 허브가 인터넷이 될 때 올린다. 손님 휴대폰은 셀룰러로 접속하므로
  QR 링크는 공개 주소일 수밖에 없다. 그래서 인터넷이 끊긴 동안 찍은 사진의 QR은 연결이 돌아온 뒤에야
  나온다. 이 한계는 어떤 구조로도 없앨 수 없다.
- **허브는 부스 노트북에서 돈다 (권장).** 이유는 1.4.

## 1.3 왜 이 구조인가 (대안과 버린 이유)

| 선택            | 고른 것                                                                              | 버린 대안과 이유                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준 저장소     | 현장 허브                                                                            | **지금 구조 유지(클라우드 기준):** 인터넷이 끊기면 검수·벽이 멈추고 벽은 2분 뒤 사진을 모두 내린다. 요구 원칙 1번과 완료 기준 1번을 못 지킨다                                                                                                                                                                         |
| 허브 소프트웨어 | 이 Next.js 앱을 역할만 바꿔 실행                                                     | **별도 앱(Electron, Python 서버):** 이미 계약 테스트를 통과한 저장 규칙·검수 상태 머신·벽 스케줄러를 다시 만들어야 한다. 10주 남은 일정에 맞지 않는다                                                                                                                                                                 |
| 허브 DB         | 기존 로컬 백엔드(JSON 파일 + 이미지 파일, 원자적 저장)                               | **SQLite:** Node 22의 `node:sqlite`는 아직 실험 기능(이 환경에서 경고 확인). `better-sqlite3`는 네이티브 빌드라 빌린 Windows 노트북에서 설치 위험. 기존 백엔드가 이미 검수·감사·벽 규칙 계약 테스트를 통과한다. **사진 5,000장 + 감사 기록 2만 건에서 쓰기 지연을 재고, 기준(1회 저장 200ms) 넘으면 SQLite로 바꾼다** |
| 클라우드 동기화 | 허브 서버 → Vercel `/api/hub/*` (허브 전용 비밀값, 올리기·지우기·토큰 재발급만 가능) | **허브에 Supabase service-role 키:** 노트북을 잃어버리면 모든 사진을 읽을 수 있는 키가 샌다. **부스가 클라우드와 허브에 따로 올리기:** 다른 출처 간 쿠키 인증이 필요해 복잡하고 부스 코드가 두 갈래가 된다                                                                                                            |
| 스태프 로그인   | 허브의 이름 + PIN (scrypt 해시, 시도 제한, HttpOnly 세션)                            | **Supabase 이메일 코드:** 인터넷과 메일이 필요하다. **로그인 없음:** 같은 공유기에 붙은 누구나 사진을 승인·삭제할 수 있다                                                                                                                                                                                             |
| 미디어월 렌더링 | DOM + CSS transform/opacity (지금 방식)                                              | **Canvas/WebGL(PixiJS):** 화면에 스트립 10장 안팎이면 DOM으로 충분할 것으로 추정. Phase 4에서 프레임레이트를 재고 기준(평균 55fps 이상, 1% 구간 30fps 이상) 미달이면 Canvas로 바꾼다                                                                                                                                  |
| 프로세스 감시   | 시작 스크립트의 재시작 루프 (`.bat` / `.command`)                                    | **pm2:** 의존성 추가. **Windows 서비스:** 빌린 노트북에 관리자 권한이 있다는 보장이 없다                                                                                                                                                                                                                              |

## 1.4 부스 배치: 왜 허브를 부스 노트북에서 돌리나

**사실:** 브라우저는 카메라(`getUserMedia`)와 `crypto.randomUUID`(부스 세션 id에 씀)를 보안 출처(https 또는
`localhost`)에서만 허용한다. 허브를 다른 PC에 두고 부스가 `http://192.168.x.x`로 접속하면 카메라가 안 켜진다.

| 방법                                                                         | 장점                                                                      | 단점                                                      | 판단               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| **A. 허브 = 부스 노트북** (`localhost`)                                      | 보안 출처라 그대로 동작. 기기 1대 절약. 부스↔허브 사이 네트워크 장애 없음 | 부스 노트북이 꺼지면 허브도 꺼진다 (벽은 캐시로 2분 버팀) | **권장**           |
| B. 허브 별도 PC + 부스 Chrome에 `--unsafely-treat-insecure-origin-as-secure` | 역할 분리                                                                 | 노트북에서만 가능 (태블릿 불가). Chrome 플래그 의존       | A가 안 될 때       |
| C. 허브 별도 PC + 자체 서명 HTTPS 인증서를 모든 기기에 설치                  | 태블릿도 가능                                                             | 기기마다 인증서 설치. 스태프가 하기 어렵다                | 태블릿 부스일 때만 |

부스를 태블릿으로 하게 되면 C가 필요하다. 그 경우는 부스 기기가 정해진 뒤 다시 판단한다.

벽 PC와 스태프 휴대폰은 카메라를 쓰지 않으므로 LAN의 `http://<허브 주소>:3000`으로 붙는다. 이 경우 쿠키는
`Secure` 없이 나가므로 **공유기는 스태프만 아는 비밀번호로 잠근 전용 공유기**여야 한다. 교회 공용 와이파이에
허브를 올리지 않는다.

## 1.5 흐름

### 촬영과 QR

> **구현됨 (Phase 2-5, D57).** `lib/cloud/`, 클라우드 쪽 `/api/hub/*`, 부스의 `/api/photos/qr`. E2E는
> 허브와 클라우드 서버 두 개를 띄우고 그 사이 연결을 끊었다 붙여서 확인한다(`e2e/cloud.spec.ts`).

1. 부스가 4컷을 합성한다(지금 그대로). JPEG를 IndexedDB 큐에 먼저 저장하고 허브로 보낸다(`localhost`).
2. 허브는 사진을 디스크에 저장하고, 같은 요청 안에서 클라우드 업로드를 한 번 시도한다(제한 시간 기본 8초,
   설정값).
   - 성공: 클라우드가 만든 링크를 부스에 그대로 넘긴다. **허브는 원본 토큰을 저장하지 않는다.**
   - 실패: 허브는 "저장됨, QR 준비 중"을 돌려주고 동기화 큐에서 재시도한다. 부스는 "QR 준비 중" 화면에서
     허브에 다시 묻는다. 그사이 클라우드에 올라갔으면 허브가 같은 세션의 토큰을 새로 발급받아 넘긴다(기존
     D20 방식: 같은 행, 새 토큰).
3. 손님이 기다리지 못하면 "QR 없이 다음으로"를 눌러 벽 노출 질문으로 넘어간다. 사진은 허브에 남고 벽
   노출은 동의대로 진행된다. 화면에 세션 번호 8자리가 나오므로, 손님이 나중에 다시 오면 스태프가
   `/admin` 최근 세션에서 찾아 "QR 다시 보여주기"로 준다(인터넷이 돌아온 뒤). 아무도 묻지 않은 사본은
   허브가 15초마다 돌면서 올린다.
4. 가짜 QR은 여전히 없다. QR은 클라우드가 실제로 사진을 받은 뒤에만 나온다.

### 동의 (R1·R2 수정 포함)

> **구현됨 (Phase 2-2, D56).** `lib/offline/consent-queue.ts`, `/api/photos/consent`의 `sessionId`.

- 부스의 벽 노출 선택은 허브로 간다. 허브는 같은 LAN 안이라 인터넷과 무관하다.
- 선택은 사진과 같은 큐에 넣어, 허브가 잠깐 응답하지 않아도 사라지지 않는다. 지금은 QR이 준비된 뒤에만
  보내고 한 번 실패하면 버려진다(AUDIT R1·R2).
- 클라우드에는 동의 정보를 보내지 않는다. 클라우드 사본은 다운로드에만 쓴다.

### 검수와 벽

- 스태프가 허브 `/admin`에서 승인한다. 규칙은 `lib/ops/moderation.ts` 그대로다. 동의 없는 사진은 승인할 수
  없고, 승인 전 사진은 벽 피드에 들어가지 않는다.
- 벽은 허브 `/api/wall/feed`에서 **노출 순서가 정해진 id 목록**을 받는다(1.7). 화면에 띄운 사진은
  `/api/wall/shown`으로 허브에 알려 노출 기록이 디스크에 남는다.
- 비상 스위치(벽 일시정지, 대기 화면)는 지금처럼 서버가 적용한다.
- **운영 시간:** 허브 설정에 벽 운영 시간을 둔다. 시간 밖이면 피드가 대기 화면 모드를 보낸다. 스태프는
  관리자 화면에서 즉시 켜고 끌 수 있다(시간표보다 우선).

### 삭제와 보관

- 허브에서 삭제하면 허브의 이미지가 바로 지워지고, 클라우드 삭제를 바로 한 번 보내고 실패하면 동기화 큐에
  남는다. 인터넷이 돌아오면 클라우드 사본과 링크도 죽는다. 관리자 개요에 "QR 대기 N건 · 삭제 대기 N건"을
  보인다(구현됨, 2-5).
- 클라우드 사본은 클라우드의 기존 보관 작업이 `PHOTO_RETENTION_DAYS`가 지나면 지운다. 클라우드에서는 이
  값을 링크 유효 기간에 맞춰 짧게 둔다(예: 링크 24시간, 보관 1일). 무료 요금제 저장 한도(1.10)도 이걸로
  맞춘다. 클라우드에서 지운 사본은 되살리지 않는다(삭제는 되돌릴 수 없음). 그 뒤 스태프가 "QR 다시
  보여주기"를 누르면 관리자 화면이 "QR 서버의 보관 기간이 끝났어요"라고 알려 준다. 사진은 허브에 남는다.
- 허브 보관 규칙은 기획안 제안값을 기본값으로 두고 교회 확인 뒤 바꾼다(모두 설정값).
  - QR 링크: 24시간 (지금 코드 기본값 72시간에서 변경)
  - 벽에 게시되지 않은 사진(동의 안 함, 거절, 승인 대기 중 만료): 촬영 후 24시간
  - 벽 게시 사진: 행사 종료 시각(`eventEndAt`) + 24시간
- 허브에는 Vercel 크론이 없으므로 허브 프로세스 안에서 보관 작업을 주기적으로 돌린다.
- **14세 미만 기준은 교회 결정 전까지 구현하지 않고 막힘으로 둔다.** 그때까지는 모든 벽 사진이 사람 검수를
  거치고, 검수자는 어린이가 보이면 보호자 확인 전까지 승인하지 않는다(운영 규칙).

## 1.6 데이터 모델

허브는 지금의 테이블(행) 구조를 그대로 쓰고 아래만 더한다. 클라우드는 지금 Supabase 스키마를 그대로 쓰되
동의·검수 컬럼은 쓰지 않는다(항상 `false` / `NONE`).

| 대상                             | 필드                                                                                                                        | 설명                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 사진 (기존 `PhotoRow`)           | id, sessionId, kioskId, frameId, createdAt, objectPath, thumbPath, wallConsent, moderationStatus, deletedAt 등              | 그대로. 이름·연락처·얼굴 정보 없음                               |
| 사진 (추가)                      | `wallPath`                                                                                                                  | 벽용 이미지. 640 썸네일 대신 벽 해상도에 맞춘 JPEG(1.8)          |
| 사진 (추가)                      | `cloud`: `PENDING` / `SYNCED` / `DELETE_PENDING` / `DELETED` / `FAILED`, `cloudAttempts`, `cloudSyncedAt`, `cloudLastError` | 클라우드 사본 상태. 원본 토큰은 없다                             |
| 노출 기록 (신규)                 | photoId, `shownCount`, `firstShownAt`, `lastShownAt`                                                                        | 벽이 보고한 노출. 로테이션 순서의 근거. 새로고침·재부팅에도 유지 |
| 바로 띄우기 (신규)               | photoId, requestedAt, requestedBy                                                                                           | 스태프의 "지금 띄우기" 요청. 한 번 노출되면 소진                 |
| 스태프 (기존 `StaffMember` 변경) | id, 이름, `pinHash`(scrypt), active                                                                                         | 허브 PIN 로그인. 이메일 없음                                     |
| 설정 (기존 `EventSettings` 추가) | `wallHours` (요일별 시작·끝), `wallForce`: `auto` / `on` / `off`                                                            | 벽 운영 시간과 수동 전환                                         |
| 감사 기록                        | 기존 그대로                                                                                                                 | 승인·삭제·바로 띄우기·설정·스태프 변경 모두 기록                 |

## 1.7 로테이션 알고리즘과 공정성 기준

> **구현됨 (Phase 2-3).** `lib/wall/rotation.ts`(순서), `lib/wall/scheduler.ts`(벽의 선택),
> `lib/wall/server.ts`(피드), `/api/wall/shown`(노출 보고), `/api/admin/photos/:id/show-now`.

### 기호

- `S` = 화면에 동시에 걸리는 스트립 수 (설정, 기본값은 해상도 확정 후)
- `C` = 한 자리가 한 번 도는 시간. 등장 1.5 + 노출 14 + 퇴장 1.5초를 1초 단위 스케줄러로 돌리면
  **18초**가 된다(2 + 14 + 2).
- `N` = 지금 벽에 걸 수 있는 사진 수 (승인 + 동의 + 미삭제)
- `P` = 피드 폴링 간격. 기획안의 "숨김 5초 이내"에 맞춰 10초 → **5초**로 줄였다
- `K` = cooldown, 같은 사진이 내려간 뒤 다시 오르기 전 쉬는 시간(60초)

### 순서 (허브가 계산, 벽은 따르기만 함)

1. **바로 띄우기** 요청된 사진. 요청 순서대로.
2. **한 번도 안 나간 사진.** 촬영 순서대로. 새 사진이 이미 기다리던 새 사진을 새치기하지 않는다.
   (설계 초안은 승인 순서였다. 승인 시각을 따로 저장하지 않으므로 촬영 순서로 했다: D54.)
3. **나머지.** 노출 횟수가 적은 순, 같으면 마지막 노출이 오래된 순.

벽은 이 순서에서 이미 화면에 있거나 휴식 중이 아니고 이미지가 준비된 첫 사진을 빈 자리에 건다. 피드는
**순서상 앞쪽 `max(4S, 30)`장 + 지금 화면에 있는 사진**만 보낸다. 사진이 수천 장이어도 응답 크기는
일정하다. 화면에 있는 사진을 같이 보내는 이유: 노출 직후 순서 맨 뒤로 가더라도 노출 도중에 내려가면 안
되기 때문이다(벽이 `?on=`으로 알려 준다).

벽은 사진을 걸 때마다 `/api/wall/shown`으로 보고하고, 허브는 이것으로 노출 기록을 쌓는다. 노출 기록은
허브 디스크에 30초 이내로 모아 저장한다(D53).

바로 띄우기는 빈 자리를 기다리지 않는다. 비거나 내려가는 중인 자리가 없으면, 다 등장해서 가장 오래 걸려
있던 사진을 바로 퇴장시키고 그 자리에 건다. 바로 띄우기 사진은 휴식 시간을 무시하고, 다른 바로 띄우기
사진을 밀어내지 않는다.

### 기준 (수치)

| 번호 | 기준                                                                      | 값                                                                                                                 |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| F1   | 바로 띄우기를 누른 뒤 화면에 나타날 때까지                                | **10초 이하**. 걸린 뒤에는 노출 시간을 다 채움                                                                     |
| F2   | 새로 승인된 사진의 첫 노출                                                | 앞에 기다리는 미노출 사진이 `S`장 이하일 때 **30초 이하**. 일반적으로 `ceil((대기 수 + 1) / S) × C + P + 2초` 이하 |
| F3   | 굶주림 없음: 계속 적격인 사진의 노출 간격                                 | **`max(ceil(N / S) × C, C + K) + C + P` 이하** (예: N=1,000, S=6 이면 약 50분)                                     |
| F4   | 고르게: 같은 구간 내내 적격이던 사진들(바로 띄우기 제외)의 노출 횟수 차이 | **1 이하**                                                                                                         |
| F5   | 반복 방지: `N > S`일 때 같은 사진의 재등장 간격                           | **K(60초) 이상**                                                                                                   |
| F6   | 금지 사진: 숨김·삭제·벽 일시정지 후 화면에서 사라질 때까지                | **폴링 1회(5초) 이하**                                                                                             |

F3의 `C + K` 항은 시뮬레이션에서 찾은 것이다. 사진이 자리 수보다 조금 많으면(예: N=7, S=6) 휴식 시간이
간격을 정한다. 처음 식(`ceil(N/S) × C + C + P`)은 이 경우 59초를 약속했지만 실제는 78초였다.

### 측정 결과 (2026-10-12, `tests/unit/rotation.test.ts`)

실제 `config/wall.ts` 값과 실제 순서 함수·스케줄러로 가상 시계를 돌렸다. 이미지는 즉시 준비된다고
가정했다(실제 벽은 LAN에서 이미지를 받는 시간이 더해진다). `FTL_SIM_REPORT=1`로 아래 값을 다시 출력할 수
있다.

| 시나리오                                                                                        | 측정                                                                                                     | 기준                                | 판정 |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---- |
| N=500, S=6, 12시간                                                                              | 최대 간격 1,508초, 사진당 노출 28~29회, 최소 재등장 1,496초                                              | F3 ≤ 1,535초, F4 ≤ 1, F5 ≥ 60초     | 통과 |
| N=50, S=5, 12시간                                                                               | 최대 간격 180초, 노출 240~241회                                                                          | F3 ≤ 203초                          | 통과 |
| N=7, S=6, 2시간                                                                                 | 최대 간격 78초, 노출 93회씩                                                                              | F3 ≤ 101초                          | 통과 |
| N=5,000, S=6, 9시간                                                                             | 최대 간격 15,008초(약 4.2시간), 노출 2~3회. 모든 사진 1회 이상                                           | F3 ≤ 15,035초                       | 통과 |
| 바쁜 저녁 6시간: 처음 40장 + 20~100초마다 승인(362장), 바로 띄우기 40회, 화면 위 사진 숨김 55회 | 바로 띄우기 최대 6초. 첫 노출 중앙값 4초, 95% 지점 9~11초, 최대 82초. 숨긴 사진이 내려갈 때까지 최대 4초 | F1 ≤ 10초, F2, 95% ≤ 90초, F6 ≤ 5초 | 통과 |

**미검증:** 실제 벽 브라우저에서의 이미지 로딩 시간, 실제 LED와 실제 PC에서의 장시간 구동.

## 1.8 미디어월 화면

- **장면:** 밤 11시 한림의 방. 정면에 크게 열린 창, 창밖 별이 가득한 하늘, 방 안을 가로지르는 빨랫줄,
  집게에 걸린 네컷 스트립. 새 스트립은 집게에 걸리며 살짝 흔들리고, 나갈 때 집게에서 빠진다.
- **해상도:** `config/wall.ts`의 `canvas: { width, height }`로 고정 픽셀 장면을 만들고 화면에 비율을 지켜
  맞춘다. LED 입력 해상도를 받기 전에는 레이아웃을 확정하지 않는다. 1920×1080, 3840×1080, 3840×2160과
  가로로 긴 비율(예: 4:1)에서 스크린샷으로 확인한다.
- **가독성:** 스트립 한 장이 LED에서 차지하는 높이를 설정으로 정하고, 벽용 이미지(`wallPath`)는 그 높이
  이상으로 만든다. 지금 쓰는 640 썸네일(한 컷 약 190×140 픽셀)은 쓰지 않는다. 실제 관람 거리에서 얼굴이
  읽히는지는 현장 리허설에서만 확인할 수 있다(막힘).
- **로컬 번들:** 폰트·장면 그림은 모두 앱에 포함한다. 인터넷 없이 동작.
- **성능:** 애니메이션은 transform과 opacity만 쓴다. 이미지는 `decode()`가 끝난 뒤 건다. 내려간 사진의
  object URL은 바로 해제한다. **저사양 모드**(설정)는 별 반짝임·흔들림을 끄고 `S`를 줄인다.
- **워치독:**
  1. 페이지 안: 화면 갱신(`requestAnimationFrame`)이 10초 이상 멈추거나 처리 안 된 오류가 나면 스스로
     새로고침한다.
  2. 운영 시간 밖에 하루 한 번 계획된 새로고침.
  3. 브라우저가 죽으면 시작 스크립트가 다시 띄운다.
  4. 벽은 심장박동에 프레임레이트와(가능하면) 메모리 사용량을 실어 보낸다. 관리자 상태판에 보인다.

## 1.9 부스

- 흐름: 시작 → 카메라 → 3·2·1 → 4컷 → 마음에 안 드는 컷 재촬영 → 프레임 선택 → 미리보기 → QR → 벽 노출
  선택 → 끝 → 자동 복귀. 일정 시간 입력이 없으면 처음으로.
- **프레임 선택은 촬영 뒤에 둔다 (요청서와 다름).** 모든 프레임이 같은 4:3 칸이라 언제 골라도 결과가 같고
  (D6), 촬영 전에 결정할 일이 하나 줄어 어르신과 아이에게 쉽다. 촬영 전으로 바꾸는 건 설정 하나로 가능하게
  한다.
- 카운트다운: 지금의 큰 숫자 + 짧은 효과음(브라우저에서 생성, 파일 불필요). 음성은 녹음 파일을 넣을 수
  있게만 만든다. 문구("LIGHTS, CAMERA, ACTION!" 등)는 설정값.
- 버튼: 주 버튼 80px 이상 유지(요구 64px 이상).
- **스태프 도움 모드:** 화면 구석을 3초 길게 누르고 PIN 입력. 카메라 선택, 전송 대기 목록, 처음으로, 화면
  새로고침.

## 1.10 비용 (상한 50만원)

| 항목                   | 예상                                 | 근거                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Hobby           | 0원                                  | 비영리 교회 행사. 크론 하루 1회 제한은 지금 설계와 맞음                                                                                                                                              |
| Supabase Free          | 0원                                  | 제3자 자료 기준 저장 1GB, DB 500MB, 7일 비활성 시 일시정지. **공식 가격표 미확인.** 클라우드 사본을 링크 유효 기간만 두면 사진 약 0.6MB(추정) × 3일치로 한도 안. 일시정지는 행사 전 점검 일정에 포함 |
| Supabase Pro (필요 시) | 월 약 3.5만원                        | 무료 한도를 넘을 때만                                                                                                                                                                                |
| 전용 공유기            | 3~5만원                              | 보안(1.4)                                                                                                                                                                                            |
| 웹캠 (빌리지 못하면)   | 3~6만원                              |                                                                                                                                                                                                      |
| 조명                   | 1~3만원                              | 다이소                                                                                                                                                                                               |
| 백업용 USB 메모리      | 1~2만원                              |                                                                                                                                                                                                      |
| LAN 케이블             | 1만원                                |                                                                                                                                                                                                      |
| **합계 (최대)**        | **약 20만원 + 필요 시 Supabase Pro** | 50만원 안                                                                                                                                                                                            |

허브·부스·벽 PC는 빌린 노트북을 쓴다고 가정한다.

## 1.11 장애 시나리오

| 상황                           | 시스템 동작                                                                                       | 스태프 대응                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 인터넷 끊김                    | 촬영·동의·검수·벽 모두 계속. QR만 "준비 중". 허브가 자동 재시도                                   | 손님에게 "QR이 늦어지면 잠시 뒤 다시 와 달라"고 안내. 공유기·인터넷 선 확인. 상태판 "클라우드 대기 N건" 확인 |
| 현장 공유기(LAN) 끊김          | 부스는 허브와 같은 노트북이라 계속 촬영. 벽은 2분 동안 캐시로 버티다 대기 화면                    | 공유기 전원 껐다 켜기. 벽은 자동 복구                                                                        |
| 카메라 연결 끊김               | 부스가 "카메라를 확인해 주세요" 화면. 촬영한 컷은 유지                                            | USB 다시 꽂기 → 화면의 "다시 시도". 안 되면 스태프 도움 모드 → 카메라 선택                                   |
| 미디어월 PC 재부팅             | 시작 스크립트가 브라우저를 전체화면으로 띄움. 노출 기록은 허브에 있어 순서 이어짐                 | 자동. 5분 넘게 안 뜨면 시작 스크립트 아이콘 더블클릭                                                         |
| 벽 화면 멈춤                   | 워치독이 10초 안에 새로고침                                                                       | 자동. 반복되면 저사양 모드 켜기                                                                              |
| 허브(부스 노트북) 재시작       | 시작 스크립트가 허브 → 부스 화면 순서로 띄움. 데이터는 디스크에 있음. 촬영 중이던 세션은 처음부터 | 노트북 켜고 로그인만. 부스 IndexedDB에 남은 사진은 자동 업로드                                               |
| 허브 노트북 고장               | 벽은 2분 뒤 대기 화면. 촬영 불가                                                                  | 다른 노트북에 최신 백업 복사 → 시작 스크립트. RUNBOOK "허브 교체" 절차                                       |
| 디스크 거의 참                 | 상태판 경고(남은 용량 기준 설정값). 한계 아래면 새 촬영 거절 전에 스태프 경고                     | 백업 확인 후 행사 종료 사진 아닌 임시 파일 정리. 다른 노트북으로 교체                                        |
| 정전                           | 모두 꺼짐. 디스크에 저장된 것은 안전(원자적 저장)                                                 | 전원 복구 후 각 기기 시작 스크립트                                                                           |
| 잘못된 사진이 벽에 나감        | —                                                                                                 | 관리자 → 벽 일시정지 또는 해당 사진 숨김·삭제 (5초 안에 화면에서 사라짐)                                     |
| 스태프 휴대폰 분실             | 세션은 PIN 로그인이라 휴대폰만으로는 다시 못 들어옴(세션 만료 전엔 가능)                          | 관리자에서 그 스태프 비활성화 → 세션 즉시 무효                                                               |
| Supabase 일시정지(무료 요금제) | QR만 실패, 나머지 정상                                                                            | 대시보드에서 복구. 행사 전 점검 목록에 포함                                                                  |

## 1.12 구현 순서 (Phase 2)

요청서 순서(Hub → Booth → Wall → Admin → 클라우드)를 따르되, 각 PR은 테스트를 포함해 독립적으로 병합 가능하게
나눈다.

1. **허브 역할과 PIN 로그인:** `FTL_ROLE=hub|cloud`, LAN용 설정 검증, 스태프 PIN, 관리자 화면이 로컬
   백엔드로 동작, 허브 안 보관 작업.
2. **부스 → 허브, 동의 유실 수정:** 큐에 동의 포함, "QR 준비 중" 상태, 스태프 도움 모드.
3. **로테이션 공정성 + 노출 기록 + 바로 띄우기:** 1.7 기준과 12시간 시뮬레이션 테스트.
4. **미디어월 장면 교체:** 빨랫줄 장면, 해상도 설정, 벽용 이미지, 워치독, 저사양 모드.
5. **클라우드 동기화:** `/api/hub/*`, 동기화 큐, 삭제 전파, 상태판.
6. **운영 도구:** 시작 스크립트(Windows/macOS), 백업, 디스크 경고, RUNBOOK 완성.

## 1.13 일정 위험

기획안의 10/23 검증(실제 카메라 → QR)까지 11일이다. 이 검증은 **지금 코드(클라우드 구조)로도 할 수 있다.**
Vercel 미리보기 배포와 실제 웹캠, 실제 휴대폰만 있으면 된다. 허브 전환을 기다리지 말고 지금 구조로 먼저
통과시키는 것을 권한다. 단, 배포는 계정·프로젝트 생성이 필요하므로 사람이 해야 한다(`docs/DEPLOYMENT.md`).

허브 전환(1.12의 1~6)은 11/9 LED 실공간 시험 전에 끝내는 것을 목표로 한다.

---

# 2부. 현재 구현 (Phase 1~4, 클라우드 기준)

_아래는 2026-10-12 `main` 코드 그대로의 설명이다(영문). 1부의 목표 구조로 옮길 때 재사용하는 부품이다._

One Next.js application serves every surface, and there are no microservices. In deployment it
runs on Vercel. Supabase provides Postgres and a private Storage bucket and is reached only from
the Next.js server.

```
 ┌─────────────── Kiosk browser (/kiosk, enrolled) ───────────────┐
 │ CameraProvider ─► grabFrame (crop+mirror)                       │
 │ kioskReducer (pure) ◄── KioskApp effects                        │
 │ composeFrame(FrameDefinition, 4 images) ─► JPEG                 │
 │        │                                                        │
 │ UploadQueue ── IndexedDB (JPEG + session id, survives reload)   │
 │        │ POST /api/photos   cookie: ftl_kiosk (HttpOnly)        │
 └────────┼────────────────────────────────────────────────────────┘
          ▼
 ┌─────────────── Next.js server (trusted boundary) ───────────────┐
 │ env.ts validation · kiosk auth · Origin check · rate limit      │
 │ PhotoService (all rules) ──► StorageBackend                     │
 │     memory (tests) │ local files (dev) │ Supabase (deployment)  │
 │ /p/[token] page · /p/[token]/image (bytes from private bucket)  │
 │ /api/cron/retention (Vercel Cron, Bearer CRON_SECRET)           │
 └────────┼────────────────────────────────────────────────────────┘
          ▼  service_role (server only)
 ┌──────── Supabase ────────┐            Guest phone (any network)
 │ photos, kiosks (RLS on)  │            scans QR → https://PUBLIC_BASE_URL/p/<token>
 │ bucket "photos" private  │
 └──────────────────────────┘
```

## Kiosk (unchanged from Phase 1 except delivery)

- `lib/kiosk/machine.ts`: pure reducer. Phase 2 adds `delivery.status = "queued"` (reason
  `network | auth`). A queued or late failure can never replace a QR that is already ready.
- `components/kiosk/kiosk-app.tsx`: effects only. Delivery goes through the queue (below), and
  the QR is rendered from the **server-returned URL**.
- `/kiosk` is a server component that first validates the config and the kiosk session. On
  failure it renders a staff screen and never starts the guest flow.

## Offline queue (`lib/offline`)

- `IndexedDbQueueStore` (`follow-the-lights` / `uploads`, key `sessionId`) stores the JPEG as an
  ArrayBuffer plus frame, mime, createdAt, attempts, nextAttemptAt, lastError, and state.
- `UploadQueue`:
  1. `enqueue` persists first.
  2. `deliverNow` makes one attempt. At most one is in flight per session.
  3. Outcomes:
     - success → delete the entry and emit `uploaded`
     - network/5xx/429 → back off 2 s, 5 s, 15 s, 30 s, then 60 s
     - 401 → `auth` state, retried every 60 s
     - 400/403/413/415/409 → drop (it can never succeed)
  4. `processDue` runs on start, every 5 s, and on `online` (forced).
- The QR appears only on `uploaded` for the **current** session. A previous guest's photo that
  finishes later is uploaded silently and never shown to the next guest.
- Falls back to memory when IndexedDB is unavailable (staff badge `임시 저장소`).

## Server

- `lib/server/env.ts` parses and validates every setting once. _Strict_ (production) mode requires
  an https, public `PUBLIC_BASE_URL`, strong secrets, enabled kiosk auth and `CRON_SECRET`.
  `FTL_ALLOW_LOCAL_ORIGIN=1` relaxes this for the E2E production build and is ignored on Vercel.
- `lib/kiosk-auth`: signed cookie `v1.<kioskId>.<iat>.<exp>.<hmac>`. Verification also requires a
  live `kiosks` row. See `docs/SECURITY.md`.
- `lib/server/request.ts`: `isSameOrigin`, `readBodyLimited` (hard cap while streaming),
  `hasImageSignature` (JPEG SOI+EOI, PNG signature), `safeEqual`.
- `lib/server/rate-limit.ts`: fixed-window, in-process counters. Limits are per instance on
  serverless (documented).
- `lib/server/log.ts`: JSON lines. Keys that look like tokens or secrets are redacted.

## Storage (`lib/storage`)

- `PhotoService` holds every rule:
  - **put**: object first, then row. On a duplicate session (same kiosk, still active) it keeps
    the row and object and rotates the token; on a race it deletes its own object and reissues.
  - **resolve/read**: by `sha256(token)`; unknown, malformed, expired and deleted all count as
    unavailable.
  - **setWallConsent**: `NONE ⇄ PENDING` only, and only by the uploading kiosk.
  - **purgeRetention**: remove the object, then mark `DELETED`. Idempotent.
- Backends implement only `PhotoRepository`, `ObjectStorage` and `KioskRepository`:
  - `memory-backend.ts` for tests
  - `local-backend.ts`: one JSON DB per process plus object files, for dev or a single PC
  - `supabase-backend.ts`: supabase-js with the service role, `server-only`
- `guest.ts` is the only lookup guest routes use, so the "unavailable" cases look identical.
- Tokens are 192-bit, base64url (32 chars). Only the SHA-256 hex is stored.

## Guest phone page

- `/p/[token]`: server-rendered. `notFound()` gives an identical 404 for every unavailable case.
  `noindex`, `no-referrer`.
- `/p/[token]/image`: streams bytes read server-side. Headers: `private, no-store` and `nosniff`.
  `?download=1` sets an attachment disposition.
- **사진 저장하기** prefetches the file (Safari only allows `share()` right after a tap). It opens
  the share sheet with the file when `navigator.canShare({files})` is supported (iPhone → 이미지
  저장) and otherwise downloads. There is also a **파일로 받기** link and long-press guidance.
  JavaScript cannot save straight to the iOS Photos library.

## Retention

`vercel.json` cron calls `/api/cron/retention` daily at 03:17 KST, using `Authorization: Bearer
$CRON_SECRET`. Each run handles up to 5 batches of 200. Failures stay unmarked and are retried
the next day.

## Staff operations (Phase 3)

```
staff browser ──HttpOnly sb-* cookies──► Next.js (/admin pages, /api/admin/*)
                                            │ 1. Supabase Auth getUser()  (identity)
                                            │ 2. staff_members active row (authorization)
                                            │ 3. mutations: same-origin + JSON (CSRF)
                                            ▼
                                 PhotoService / lib/ops  ──service_role──► Supabase
                                                          audited SQL functions (ftl_*)
```

- **Auth:** `lib/staff-auth/server.ts` creates `@supabase/ssr` server clients with the anon key.
  Cookies are forced to HttpOnly, SameSite=Lax, Secure (in production). Login:
  - `POST /api/admin/auth/otp` emails a code, but only to active staff; the response is identical
    otherwise. `shouldCreateUser: false`, and signups are disabled project-wide.
  - `POST /api/admin/auth/verify` sets the session, then re-checks the allowlist. A non-staff
    session is expired immediately.
- **Authorization** runs on every request, in `staffRoute` (APIs) and `requireStaff` (pages; the
  layout is not re-rendered per navigation, so pages check too). `proxy.ts` only refreshes tokens.
- **Moderation** (`lib/ops/moderation.ts`) is a pure transition table. `PhotoService.moderate`
  plans the change, then applies it as a compare-and-set (`ftl_photo_transition`): the status
  update and its `audit_events` row commit together, or neither does. A concurrent change → 409.
- **Delete:**
  1. Mark the row DELETED (`deleted_at`), which kills the guest link.
  2. Remove the image and thumbnail objects.
  3. Set `object_deleted_at`.
     If storage removal fails, the retention job finishes it (`listObjectCleanupDue`).
     The DB trigger makes DELETED terminal.
- **Token rotation** (`ftl_photo_rotate_token`) writes a new hash and expiry, capped at retention,
  and audits it. It only happens on the explicit POST.
- **Staff images:** `GET /api/admin/photos/:id/image?variant=thumb|full` reads the private bucket
  on the server after the staff check.
  - Thumbnails are ~640px JPEGs made with `sharp` at upload (or lazily for older photos), stored
    as `….thumb.jpg`.
  - Grids never download originals, and no storage URL ever reaches the browser.
- **Lists** are bounded (≤ 200 rows), newest first, using one photo query plus one kiosk-label
  query. There are no N+1 calls; `ftl_photo_stats()` returns the dashboard counts in one round trip.
- **Kiosks:**
  - One-time enrollment codes: 8 symbols, 15 minutes, stored as SHA-256 only. Consumed atomically
    by `ftl_enrollment_code_consume`, which creates the kiosk and audits it.
  - Heartbeat: `POST /api/kiosk/heartbeat` every 45 s with queue depth, camera state and build;
    the response returns the PAUSE SUBMISSIONS state.
  - Health: online ≤ 2 min, stale ≤ 15 min, otherwise offline.
- **Emergency settings:** singleton `event_settings`, updated through `ftl_settings_update`
  (audited).
  - `pause_submissions` is enforced by the consent API (409 for YES) and the kiosk (skips the
    consent screen).
  - `pause_wall` and `show_holding_screen` are applied by the wall feed (below).
- **Wall source of truth:** the `wall_eligible_photos` view (APPROVED ∧ wall_consent ∧ not
  deleted, service_role only) and `isWallEligible()` for the memory and local backends.

## Media wall (Phase 4)

```
wall browser (/wall, enrolled like a kiosk) ──cookie: ftl_kiosk──► Next.js
   poll GET /api/wall/feed every 10 s  ───►  lib/wall/server.ts wallFeed()
                                               holding? → { mode: "holding", photos: [] }
                                               paused?  → { mode: "paused",  photos: [] }
                                               else     → wall_eligible_photos (ids only)
   GET /api/wall/photos/:id/image      ───►  re-checks the row, ~640px JPEG via the server
   POST /api/kiosk/heartbeat (45 s)    ───►  shows the display online in /admin → 키오스크
```

- **Auth:** the display enrolls with a one-time code at `/kiosk/enroll?next=wall` (D36). Revoking
  it in /admin cuts the feed and images off on the next request.
- **Scheduler** (`lib/wall/scheduler.ts`, pure): up to 5 slots, at most one entrance per second.
  Each photo goes `ENTER → VISIBLE → EXIT`, then `COOLDOWN` (60 s) before it may return.
  Never-shown photos go first, newest first. A photo the feed no longer lists leaves its slot on
  the next step, in any phase.
- **Renderer** (`components/wall/wall-app.tsx`): night-village scene; screen states `BOOT`,
  `EMPTY`, `ACTIVE`, `OFFLINE`, `MAINTENANCE` (`lib/wall/states.ts`). A photo the feed stops
  listing is no longer rendered from that same render on, before the next scheduler step.
- **Offline cache:** images are held as in-memory object URLs. After 2 min without a successful
  poll every cached photo is dropped (D38). Knobs live in `config/wall.ts`.

## Known limitations

- Rate limiting is per serverless instance.
- Staff features require the Supabase backend; with the local file store `/admin` reports
  "not configured" (503 on staff APIs) instead of falling open.
- A guest who leaves while their photo is still queued gets no QR on the spot. Staff can find the
  session later (최근 세션) and show a new QR with "QR 다시 보여주기".
- The queue assumes one kiosk tab per device. Two tabs cannot duplicate a photo (the server is
  idempotent), but the second tab's response would rotate the first tab's token.
- Queue entries are never expired client-side. Staff see the count and can clear site data if
  they really must.
