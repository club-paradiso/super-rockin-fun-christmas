# FOLLOW THE LIGHTS

FOLLOW THE LIGHTS is a web-based four-cut photo booth and participatory media-wall experience for Christmas Village 2026.

> 한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다.

Guests take a four-cut photo at the booth and scan a QR code to save it on their own phone. There is
no login, phone number, email, or app. Only if they choose to, the photo can appear on the shared
Christmas Village media wall after staff review. There is **no printing**.

## Status

**Phase 2: secure public photo delivery is implemented and tested in software. It has not been
verified on a real phone or real hardware, and it is not production-ready.**

| Area                                                        | State                                              |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Kiosk: camera → countdown → 4 shots → review/retake → frame | ✅ Phase 1                                         |
| Kiosk device enrollment (HttpOnly session, revocable)       | ✅ Phase 2                                         |
| Upload → private Supabase Storage + Postgres metadata       | ✅ Phase 2 (tested against a local Supabase stack) |
| QR → `/p/[token]` public phone page, save/share             | ✅ Phase 2                                         |
| Offline upload queue (IndexedDB), reload recovery           | ✅ Phase 2                                         |
| Retention cleanup (Vercel Cron)                             | ✅ Phase 2                                         |
| Wall consent → `PENDING` (human moderation only)            | ✅ consent recorded; moderation UI is Phase 3      |
| `/admin` moderation, `/wall` media wall                     | ⏳ placeholders (Phase 3 / 4)                      |
| Real phone on cellular data, real camera, iPad, MY4CUT      | ❌ **not verified**                                |

## Surfaces

| Route           | Who          | What                                                        |
| --------------- | ------------ | ----------------------------------------------------------- |
| `/kiosk`        | Guests       | The booth (`/` redirects here). Requires an enrolled device |
| `/kiosk/enroll` | Staff        | Enroll this browser as a kiosk (once per device)            |
| `/p/[token]`    | Guest phones | Download page opened from the QR code                       |
| `/wall`         | Display      | Media wall (placeholder)                                    |
| `/admin`        | Staff        | Moderation (placeholder)                                    |

## Quick start (development)

```bash
npm install
cp .env.example .env.local      # then set KIOSK_SESSION_SECRET and KIOSK_ENROLL_SECRET
npm run dev
# 1. http://localhost:3000/kiosk/enroll  → type KIOSK_ENROLL_SECRET once
# 2. http://localhost:3000/kiosk?camera=mock   (no webcam)  or  /kiosk  (real webcam)
```

Development stores photos in `.data/` (local backend). To skip enrollment while you develop,
set `KIOSK_AUTH_DISABLED=1`. The server refuses this setting in production.

For deployment (Vercel + Supabase), see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

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
