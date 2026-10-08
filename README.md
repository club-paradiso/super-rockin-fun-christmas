# FOLLOW THE LIGHTS

FOLLOW THE LIGHTS is a web-based four-cut photo booth and participatory media-wall experience for Christmas Village 2026.

> 한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다.

Guests take a four-cut photo at the booth and scan a QR code to save it on their own phone. There is
no login, phone number, email, or app. Only if they choose to, the photo can appear on the shared
Christmas Village media wall after staff review. There is **no printing**.

## Status

**Phase 3 is done: staff operations (authentication, moderation, kiosk management, emergency
controls). It is tested in software against a local Supabase stack. It has not been deployed or
tried on real devices, and it is not production-ready.**

| Area                                                                        | State                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------- |
| Kiosk: camera → countdown → 4 shots → review/retake → frame                 | ✅ Phase 1                                         |
| Secure upload, private storage, QR → `/p/[token]`, offline queue, retention | ✅ Phase 2                                         |
| Staff login (Supabase Auth email code + allowlist)                          | ✅ Phase 3                                         |
| Moderation queue, photo library, audited state machine                      | ✅ Phase 3                                         |
| Recent sessions + "QR 다시 보여주기" (token rotation)                       | ✅ Phase 3                                         |
| Kiosk management: one-time enrollment codes, heartbeat, revoke              | ✅ Phase 3                                         |
| Emergency switches (pause submissions / wall / holding screen)              | ✅ Phase 3 (wall switches are consumed in Phase 4) |
| `/wall` media wall                                                          | ⏳ Phase 4 (placeholder)                           |
| Real phones, real staff devices, real camera, iPad, MY4CUT                  | ❌ **not verified**                                |

## Surfaces

| Route           | Who          | What                                                                                                 |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `/kiosk`        | Guests       | The booth (`/` redirects here). Requires an enrolled device                                          |
| `/kiosk/enroll` | Staff        | Enroll this browser as a kiosk with a one-time code                                                  |
| `/p/[token]`    | Guest phones | Download page opened from the QR code                                                                |
| `/admin`        | Staff        | Control panel: moderation, sessions, kiosks, emergency, audit — see [`docs/ADMIN.md`](docs/ADMIN.md) |
| `/wall`         | Display      | Media wall (placeholder until Phase 4)                                                               |

## Quick start (development)

Kiosk only (local file store, no Docker):

```bash
npm install
cp .env.example .env.local      # set KIOSK_SESSION_SECRET (and KIOSK_ENROLL_SECRET for local enrollment)
npm run dev
# http://localhost:3000/kiosk/enroll  → "공유 비밀번호로 등록" with KIOSK_ENROLL_SECRET
# http://localhost:3000/kiosk?camera=mock   (no webcam)  or  /kiosk  (real webcam)
```

With staff admin (local Supabase in Docker: Postgres, Auth, Storage, Mailpit):

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

## History

This repository previously held **AFTERGLOW**, an interactive music installation concept. That
work is preserved unchanged on the branch
[`archive/afterglow-2026-10-07`](../../tree/archive/afterglow-2026-10-07) (commit `71a6e62`).
