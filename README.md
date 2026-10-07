# FOLLOW THE LIGHTS

FOLLOW THE LIGHTS is a web-based four-cut photo booth and participatory media-wall experience for Christmas Village 2026.

> 한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다.

Guests take a four-cut photo at the booth, scan a QR code to save it on their own phone (no
login, no phone number, no email), and — only if they choose to — let it appear on the shared
Christmas Village media wall after staff review. There is **no printing**.

## Status

**Phase 1 — first vertical slice: working, not production-ready.**

| Area                                                    | State                                  |
| ------------------------------------------------------- | -------------------------------------- |
| Kiosk: camera → countdown → 4 shots → review/retake     | ✅ implemented, tested                 |
| Data-driven frames + deterministic compositor           | ✅ 3 frames                            |
| Final preview + local file download                     | ✅                                     |
| QR → `/p/[token]` phone download page                   | ✅ with a local-disk store (see below) |
| Media-wall consent screen                               | ✅ records choice as `PENDING`         |
| Supabase storage, moderation (`/admin`), wall (`/wall`) | ⏳ placeholders — see ROADMAP          |

Phase 1 stores photos on the machine running the server (`.data/`). A phone can only open the
QR link if it can reach that machine. Public delivery over the internet arrives with Supabase in
Phase 2.

## Surfaces

| Route        | Who          | What                                            |
| ------------ | ------------ | ----------------------------------------------- |
| `/kiosk`     | Guests       | The booth (`/` redirects here)                  |
| `/p/[token]` | Guest phones | Download page opened from the QR code           |
| `/wall`      | Display      | Media wall (placeholder EMPTY scene in Phase 1) |
| `/admin`     | Staff        | Moderation and emergency controls (placeholder) |

## Quick start

```bash
npm install
npm run dev
# real webcam:  http://localhost:3000/kiosk
# no camera:    http://localhost:3000/kiosk?camera=mock
```

The camera needs a secure context: `localhost` or HTTPS. Copy `.env.example` to `.env.local` to
change defaults; nothing is required for Phase 1.

## Scripts

| Command            | Does                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `npm run dev`      | Dev server                                                                                               |
| `npm run build`    | Production build                                                                                         |
| `npm run check`    | typecheck + lint + format check + unit tests                                                             |
| `npm test`         | Vitest unit tests                                                                                        |
| `npm run test:e2e` | Playwright: builds, starts a server, runs the kiosk in Chromium (mock camera and Chromium's fake webcam) |
| `npm run format`   | Prettier                                                                                                 |

## Hardware

- **Path A — self-built (reference):** any PC or tablet with a USB/web camera, light and stand,
  running this web app in a full-screen browser.
- **Path B — MY4CUT Mini (under evaluation):** treated only as a possible shell. Nothing
  vendor-specific is implemented until the device is verified (browser, camera access, iPad,
  kiosk mode, auto-start, export). See `docs/DECISIONS.md`.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product requirements
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it fits together
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phases and what is next
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — decision log
- [`CLAUDE.md`](CLAUDE.md) — working rules for AI-assisted development

## History

This repository previously held **AFTERGLOW**, an interactive music installation concept. That
work is preserved unchanged on the branch
[`archive/afterglow-2026-10-07`](../../tree/archive/afterglow-2026-10-07) (commit `71a6e62`).
