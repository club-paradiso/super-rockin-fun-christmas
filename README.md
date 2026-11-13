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
| 2.0: easy mode (large type, fewer choices) + staff default (D67)               | ✅ 2.0 (software)   |
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

CI (`.github/workflows/ci.yml`) runs all of these on every pull request, with no production secrets.

## Hardware

- **Path A — self-built (reference):** any PC or tablet with a USB/web camera, a light and a stand,
  running this web app in a full-screen browser.
- **Path B — MY4CUT Mini (under evaluation):** treated only as a possible shell. Nothing
  vendor-specific is implemented. Compatibility will be checked later on real hardware.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product requirements
- [`docs/ADMIN.md`](docs/ADMIN.md) — staff guide for `/admin`
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it fits together
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, kiosk auth, private delivery
- [`docs/SUPABASE.md`](docs/SUPABASE.md) — schema, bucket, RLS, migrations
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Vercel + Supabase setup, real-phone test
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — event-day runbook, logs, revoking a kiosk
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phases and what is next
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — decision log
- [`CLAUDE.md`](CLAUDE.md) — working rules for AI-assisted development
