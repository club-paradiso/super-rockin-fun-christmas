# STUDIO SHALOM

STUDIO SHALOM (평화의 벽; until 2026-11-11 the project was called FOLLOW THE LIGHTS, and internal
identifiers such as `FTL_ROLE` and the package name still are, see D73) is a web-based four-cut photo booth and participatory media-wall experience for Christmas Village 2026.

> 한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다.

Guests take a four-cut photo at the booth and scan a QR code to save it on their own phone. There is
no login, phone number, email, or app. Only if they choose to, the photo can appear on the shared
Christmas Village media wall after staff review. There is **no printing**.

## Status

FOLLOW THE LIGHTS 2.0 (2026-11-08): see [`docs/IMPLEMENTATION_REPORT.md`](docs/IMPLEMENTATION_REPORT.md)
and [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md). The paragraph and table below are the earlier
phase summary; [`docs/STATUS.md`](docs/STATUS.md) is the source of truth.

**Phase 4 is done in software: the media wall shows approved, consented photos in a night-village
scene and obeys the emergency switches. Phases 1–4 are tested against a local Supabase stack. The
app has not been deployed or tried on real devices, and it is not production-ready.**

| Area                                                                           | State               |
| ------------------------------------------------------------------------------ | ------------------- |
| Kiosk: camera → countdown → 4 shots → review/retake → frame                    | ✅ Phase 1          |
| Secure upload, private storage, QR → `/p/[token]`, offline queue, retention    | ✅ Phase 2          |
| Staff login (Supabase Auth email code + allowlist)                             | ✅ Phase 3          |
| Moderation queue, photo library, audited state machine                         | ✅ Phase 3          |
| Recent sessions + "QR 다시 보여주기" (token rotation)                          | ✅ Phase 3          |
| Kiosk management: one-time enrollment codes, heartbeat, revoke                 | ✅ Phase 3          |
| Emergency switches (pause submissions / wall / holding screen)                 | ✅ Phase 3 + 4      |
| `/wall` media wall: approved + consented only, enrolled display, offline cache | ✅ Phase 4          |
| 2.0: "내 사진으로 참여하기" phone upload → same review queue (D66)             | ✅ 2.0 (software)   |
| 2.0: easy mode (large type, fewer choices) + staff default (D67)               | ❌ removed (D89)    |
| 2.0: dedicated wall hostname (`WALL_HOSTS`, D68)                               | ✅ old name live    |
| /admin opens with the kiosk enrollment password (D84)                          | ✅ software         |
| Media-wall themes from Figma SS 03, chosen in /admin (D85)                     | ✅ software         |
| Wall address without enrollment; public photos only by consent (D86)           | ✅ software         |
| `studio-shalom*.vercel.app` addresses (D87)                                    | ⛔ not attached     |
| Real phones, staff devices, wall screen, camera, iPad, MY4CUT                  | ❌ **not verified** |

## Surfaces

| Route           | Who          | What                                                                                                                                                                                  |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/kiosk`        | Guests       | The booth (`/` redirects here). Requires an enrolled device                                                                                                                           |
| `/kiosk/enroll` | Staff        | Enroll this browser as a kiosk with a one-time code                                                                                                                                   |
| `/p/[token]`    | Guest phones | Download page opened from the QR code                                                                                                                                                 |
| `/m/[token]`    | Guest phones | "내 사진으로 참여하기": send one own photo for wall review (booth QR, 15 min) — [`docs/MOBILE_UPLOAD_ARCHITECTURE.md`](docs/MOBILE_UPLOAD_ARCHITECTURE.md)                            |
| `/admin`        | Staff        | Control panel: moderation, sessions, kiosks, wall background, emergency, audit. Opens with the kiosk enrollment password (D84) — see [`docs/ADMIN.md`](docs/ADMIN.md)                 |
| `/wall`         | Anyone       | Media wall. Opens without enrollment (D86): an enrolled display gets every approved photo, anyone else only photos agreed to for the public wall, and none while 공개 미디어월 is off |

`/looks` is a staff tool, not a guest surface: the colour-look comparison sheet (sample photos
only), described under [Looks](#looks-colour-filters) below.

## Quick start (development)

Kiosk only (local file store, no Docker):

```bash
npm install
cp .env.example .env.local      # set KIOSK_SESSION_SECRET (and KIOSK_ENROLL_SECRET for local enrollment)
npm run dev
# http://localhost:3000/kiosk/enroll  → "공유 비밀번호로 등록" with KIOSK_ENROLL_SECRET
# http://localhost:3000/kiosk?camera=mock   (no webcam)  or  /kiosk  (real webcam)
```

As the venue hub (the event setup: local files, staff log in with name + PIN, no Supabase):

```bash
# .env.local: FTL_ROLE=hub, PHOTO_STORE=local, KIOSK_SESSION_SECRET (≥ 32 chars)
npm run build && npx next start -H 0.0.0.0
# /admin opens with KIOSK_ENROLL_SECRET (12+ characters). For a personal PIN login instead, the
# console prints a one-time 설정 코드 → open /admin/login?staff=1 and create the first staff member.
```

With the cloud staff admin (local Supabase in Docker: Postgres, Auth, Storage, Mailpit):

```bash
npx supabase start
eval "$(npx supabase status -o env | sed 's/^/export SB_/')"
SUPABASE_URL=$SB_API_URL SUPABASE_SERVICE_ROLE_KEY=$SB_SERVICE_ROLE_KEY npm run staff:add -- me@example.org "나"
# .env.local: PHOTO_STORE=supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
npm run dev   # → /admin/login; the 6-digit code arrives in Mailpit: http://127.0.0.1:54324
```

To skip kiosk enrollment while developing, set `KIOSK_AUTH_DISABLED=1`. The server refuses this
in production. Deployment (Vercel + Supabase) is described in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Looks (colour filters)

Eight candidate looks for the guest's photos ("one film, several developments"), each a 3D LUT
applied by one WebGL1 shader. They are **behind a flag and off by default**: the booth composes
exactly as before until `NEXT_PUBLIC_LOOKS=1` is set at build time, or `?looks=1` is added to the
booth address on one tablet (`/kiosk?looks=1`), or staff turn on **사진 색 보정** in `/admin`
(every booth, from its next guest; see [docs/ADMIN.md](docs/ADMIN.md)). Guests never pick a look:
the frame decides it. Research and audit:
[`docs/research/color-market-research.md`](docs/research/color-market-research.md),
[`docs/research/existing-filter-audit.md`](docs/research/existing-filter-audit.md).

| What                        | Where                                                                    |
| --------------------------- | ------------------------------------------------------------------------ |
| The looks, as numbers       | `config/looks/index.ts` (edit, then `npm run looks:build`)               |
| Which frame gets which look | `config/looks/frame-looks.json`                                          |
| The generated LUTs          | `public/looks/<id>.cube` (33³, Adobe/Resolve `.cube`; never hand-edited) |
| Look arithmetic and shader  | `lib/looks/` (`engine.ts`, `cube.ts`, `shader.ts`, `renderer.ts`)        |
| Comparison sheet            | `/looks` (source: `looks-sheet/`)                                        |

**Open the comparison sheet on this computer**

```bash
npm install
npm run dev            # no .env needed for this page
# http://localhost:3000/looks
```

**Open it on an iPad on the same Wi-Fi** (works on the iPad mini 4, Safari 15)

```bash
npm run dev -- -H 0.0.0.0
# Find this computer's address on the Wi-Fi:
#   macOS    ipconfig getifaddr en0
#   Windows  ipconfig        (the "IPv4 Address" of the Wi-Fi adapter)
#   Linux    hostname -I
# On the iPad, in Safari:  http://<that address>:3000/looks      e.g. http://192.168.0.23:3000/looks
```

If the page does not open: both devices must be on the same network (not a guest network that
isolates devices), and the computer's firewall must allow incoming connections to port 3000. The
page needs no camera and no HTTPS.

**Change a look**

```bash
# 1. edit the numbers in config/looks/index.ts
npm run looks:build      # writes public/looks/*.cube
npm run looks:preview    # contact sheets of every look on every sample → docs/screenshots/looks/
npm run looks:measure    # is it still plain to see? each look against the original and the others
UPDATE_LOOK_SNAPSHOTS=1 npx vitest run tests/unit/looks-reference.test.ts   # accept the new pictures
npm test                 # the quality bars: skin hue, highlights, blacks, reds and greens
```

## Scripts

| Command                 | Does                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `npm run dev`           | Dev server                                                                 |
| `npm run build`         | Production build                                                           |
| `npm run check`         | typecheck + lint + format check + unit tests                               |
| `npm test`              | Vitest unit tests (integration tests skip without Supabase)                |
| `npm run test:e2e`      | Playwright: production build, kiosk auth on, mock camera + fake webcam     |
| `npm run test:supabase` | Integration tests against a local Supabase stack (`npx supabase start`)    |
| `E2E_STORE=supabase …`  | Run the E2E suite against Supabase instead of local files (see DEPLOYMENT) |
| `npm run looks:build`   | Write `public/looks/*.cube` from `config/looks` (`-- --check` only checks) |
| `npm run looks:preview` | Draw every look on every sample into `docs/screenshots/looks/`             |
| `npm run looks:measure` | How far each look is from the original and from the others (CIEDE2000)     |

CI (`.github/workflows/ci.yml`) runs all of these on every pull request, with no production secrets.

## 피부 보정 (skin retouch)

고른 사진의 얼굴 피부를 합성 직전에 한 번 다듬는다: 촬영 완료 → **피부 보정** → 색감 룩(합성기의 `grade`, 위 Looks) → 틀 합성
(`lib/kiosk/photo-stages.ts`). 얼굴 형태는 건드리지 않는다. 전부 기기 안에서 계산하고, 얼굴 좌표·마스크는 서버로
가지 않고 저장되지도 않는다. 조사와 근거는 `docs/research/skin-retouch-market-research.md`,
`docs/research/skin-retouch-audit.md`.

**기본값은 꺼짐이다.** 켜는 방법은 둘:

| 방법                          | 값                         | 쓰임                                            |
| ----------------------------- | -------------------------- | ----------------------------------------------- |
| 서버 환경 변수 `SKIN_RETOUCH` | `off` / `natural` / `glow` | 그 서버에 붙는 모든 부스(다시 빌드할 필요 없음) |
| 부스 주소에 `?retouch=`       | 같은 값                    | 그 탭만. 환경 변수보다 우선                     |

- `natural` = 자연스럽게, `glow` = 뽀샤시. 모든 수치는 `config/retouch.ts` 에 있다.
- 켜져 있으면 손님이 **사진 고르기 화면**에서 끄기 / 자연스럽게 / 뽀샤시를 고른다. 위 값은 처음에 골라져 있는 답이다.
  사진을 확정하면 바꿀 수 없고, 다음 손님은 다시 이 값에서 시작한다. 디자인 원본은 `design/README.md` 「피부 보정」.
- `?retouchHud=1` 을 붙이면 부스 화면 왼쪽 아래에 검출·보정 시간, 네 장 합계, 메모리 추정이 뜬다(개발 서버에서는
  보정이 켜져 있으면 항상 뜬다). 손님용 화면이 아니다.
- 한 장이 실패하거나 4초를 넘기면 그 장은 보정 없이 나간다. 사유는 브라우저 콘솔(`[skin-retouch] …`)과 서버 로그
  (`kiosk_retouch_failed`, 코드와 횟수만)에 남는다.
- 얼굴 모델(MediaPipe 0.10.21 non-SIMD)과 런타임은 `public/retouch/` 에서 이 서버가 직접 준다. CDN을 쓰지 않는다.

### 비교 페이지 `/retouch-lab`

샘플마다 원본 / 자연스럽게 / 뽀샤시를 나란히 놓고, 단계별 강도 슬라이더, 확대, 마스크 보기, 틀에 얹은 모습,
그리고 **그 페이지를 연 기기의 실제 처리 시간**을 보여 준다. 미리 구운 그림이 아니라 그 자리에서 계산한다.
Safari 15용으로 따로 빌드한 페이지라 iPad mini 4에서 열린다.

- 개발 서버와 Vercel 미리보기 배포에서는 그냥 열린다. 그 밖의 곳에서는 `RETOUCH_LAB=1` 일 때만 열린다(없으면 404).
- 샘플 사진의 출처와 라이선스: `public/retouch/samples/README.md`.

### iPad mini 4에서 재기 (같은 와이파이)

이 리포의 자동 시험은 데스크톱 Chromium에서 돈다. **iPad mini 4의 속도와 메모리는 사람이 실기기로 재야 한다.**
비교 페이지는 카메라를 쓰지 않으므로 https 없이 열 수 있다.

```bash
npm ci
```

```bash
RETOUCH_LAB=1 npm run build
```

```bash
RETOUCH_LAB=1 npx next start -H 0.0.0.0 -p 3000
```

1. 맥과 iPad를 같은 와이파이에 붙인다. 맥의 IP를 확인한다(시스템 설정 → 네트워크, 또는 `ipconfig getifaddr en0`).
2. iPad Safari에서 `http://<맥 IP>:3000/retouch-lab` 을 연다. (`.env.local` 이 없어도 이 페이지는 열린다.)
3. 아래 표를 채운다. 기기 OS 버전과 배포 커밋을 함께 적는다.

| #   | 할 일                                             | 볼 것                                                                           | 결과 |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| 1   | 페이지를 연다                                     | 「이 기기」에 WebGL 1 됨, SIMD 없음으로 나오는지                                |      |
| 2   | 첫 샘플의 보정이 뜰 때까지 기다린다               | 뜨는지. 안 뜨면 맨 아래 빨간 오류 문구를 그대로 적는다(`init-failed` 등)        |      |
| 3   | 「이 사진의 수치」                                | 모델을 올리는 데 걸린 시간, 검출·보정 시간, 엔진(webgl / cpu)                   |      |
| 4   | 크기 `960 (iPad mini 4)` 로 「자연스럽게로 측정」 | 네 장 합계(목표 6초), 장별 시간, 메모리 추정                                    |      |
| 5   | 「가벼운 6점」으로 바꿔 4번을 다시                | 합계가 얼마나 줄어드는지. 랜드마크 모드가 목표를 넘으면 이쪽이 후보다           |      |
| 6   | 엔진을 `CPU` 로 바꿔 4번을 다시                   | WebGL과의 차이                                                                  |      |
| 7   | 4번을 연달아 10번                                 | 탭이 다시 로드되는지(메모리), 시간이 점점 늘어나는지                            |      |
| 8   | 샘플을 하나씩 넘기며 「얼굴」 확대로 본다         | 결이 남는지, 눈·눈썹·입술·안경테·수염 경계가 번지는지, 어두운 피부가 탁해지는지 |      |
| 9   | 단체사진 샘플                                     | 작은 얼굴이 뭉개지는지, 「건너뜀」에 `too-small` 이 어떻게 나오는지             |      |
| 10  | 「틀에 얹어 보기」                                | 인화 크기에서 보정이 티가 나는지                                                |      |

부스 흐름 전체(카메라 포함)는 https가 있어야 하므로 미리보기 배포나 허브에서 `…/kiosk?retouch=natural&retouchHud=1`
로 연다(`docs/PREVIEW_DEVICE_TEST.md`, `docs/IPAD_MINI4_COMPAT.md`). 열 번 연속 촬영해 탭이 다시 로드되지 않는지 본다.

## Hardware

- **Path A — self-built (reference):** any PC or tablet with a USB/web camera, a light and a stand,
  running this web app in a full-screen browser.
- **Path B — MY4CUT Mini (under evaluation):** treated only as a possible shell. Nothing
  vendor-specific is implemented. Compatibility will be checked later on real hardware.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product requirements
- [`docs/research/color-market-research.md`](docs/research/color-market-research.md) — colour market research (2026-11-23), [`existing-filter-audit.md`](docs/research/existing-filter-audit.md) — audit of the current tones
- [`docs/ADMIN.md`](docs/ADMIN.md) — staff guide for `/admin`
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it fits together
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, kiosk auth, private delivery
- [`docs/SUPABASE.md`](docs/SUPABASE.md) — schema, bucket, RLS, migrations
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Vercel + Supabase setup, real-phone test
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — event-day runbook, logs, revoking a kiosk
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phases and what is next
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — decision log
- [`CLAUDE.md`](CLAUDE.md) — working rules for AI-assisted development
