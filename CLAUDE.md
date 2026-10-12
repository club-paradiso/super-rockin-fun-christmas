# CLAUDE.md — FOLLOW THE LIGHTS

Web four-cut photo booth + participatory media wall for Christmas Village 2026.
Next.js 16 (App Router) · TypeScript strict · Tailwind 4 · Vitest · Playwright.

## Transition in progress (read first)

Read `docs/STATUS.md` first. A local-first redesign is proposed in `docs/ARCHITECTURE.md` part 1
(decisions D39–D48): an on-site hub becomes the source of truth, the cloud keeps only a QR copy,
and staff sign in with a PIN on the hub. Until that work lands, the rules below describe the code
as it is. Change each rule in the same PR that changes the behaviour it describes.

## Non-negotiables

- **No printing.** No printer, print queue, print layout. Delivery is QR → guest's phone.
- **No personal contact collection.** No phone, email, account, SNS login. A QR token is enough.
- **Download and wall consent are independent.** Declining the wall must never affect the photo
  link. Consent UI gives both answers equal weight — no dark patterns.
- **No face recognition, biometrics, or analytics.** Store only what the service needs.
- **Moderation is human.** No AI moderation.
- **Vendor-neutral.** Do not invent MY4CUT (or any vendor) APIs. Hardware is a shell.
- **Preview = result.** Preview and capture share `KIOSK_CONFIG.captureAspect` and
  `KIOSK_CONFIG.mirror`. Never stretch an image; crop with `coverCrop`.
- **Frames are data** in `config/frames/`. Don't hard-code layout in the compositor.
- **No secrets in the browser.** Never add `NEXT_PUBLIC_` to a secret. Kiosk auth is the
  HttpOnly cookie from `/kiosk/enroll`; the browser never talks to Supabase.
- **Private photos.** Bucket stays private; guests only ever see `/p/[token]` and
  `/p/[token]/image`. Never return `objectPath`, `tokenHash` or signed storage URLs to clients.
- **Raw tokens are never stored or logged.** Only `sha256(token)`. Unknown/expired/deleted all
  return the same 404.
- **No fake QR.** A QR is shown only after the server returned a real token.
- **Schema changes are migrations** in `supabase/migrations/`, never console clicks.
- **Staff = Supabase Auth identity + active `staff_members` row**, checked server-side on every
  page (`requireStaff`) and API (`staffRoute`). A Supabase user alone is nothing. No signups.
- **Kiosk and staff auth never substitute for each other.** Kiosk APIs read only the kiosk
  cookie; staff APIs read only the Supabase session.
- **Every state change is audited atomically**: moderation, deletion, token rotation, kiosk
  rename/revoke, enrollment codes, settings, staff changes go through ONE backend call (a SQL
  `ftl_*` function on Supabase). Never update those columns directly.
- **Moderation rules live in `lib/ops/moderation.ts`.** APPROVED requires wall consent; DELETED is
  terminal and removes the image. No AI moderation, no face anything.
- **PAUSE SUBMISSIONS never blocks photography or QR delivery** — only new wall consent.
- **The wall only ever receives `wall_eligible_photos` ids**, through `/api/wall/feed`. PAUSE WALL
  and SHOW HOLDING SCREEN are applied on the server. Never give the wall anon database access,
  tokens or storage URLs.

## Layout

```
app/kiosk              booth (server gate: config + enrollment) → components/kiosk
app/kiosk/enroll       staff device enrollment
app/p/[token]          phone download page + image route (server reads private bucket)
app/api/photos         upload (kiosk auth, idempotent per session) and consent
app/api/kiosk          enroll / signout · app/api/operator/kiosks: list / revoke
app/api/cron/retention retention cleanup (Bearer CRON_SECRET, Vercel Cron)
app/admin              staff control panel: login, (staff)/ pages (overview, moderation,
                       sessions, photos, kiosks, settings, audit)
app/api/admin          staff APIs (staffRoute: Supabase session + allowlist + CSRF)
app/api/kiosk/heartbeat kiosk liveness (kiosk cookie)
app/wall               media wall (server gate: config + enrolled display) → components/wall
app/api/wall           wall feed (eligible ids only) + image proxy (kiosk cookie)
lib/wall               wall states, pure scheduler, server feed (applies emergency switches)
lib/ops                moderation rules, enrollment codes, kiosk health, staff read models
lib/staff-auth         Supabase Auth (@supabase/ssr) server clients + allowlist check
proxy.ts               refreshes staff sessions for /admin pages (no authorization here)
components/admin       admin UI (cards, dialogs, emergency switches, kiosk/staff managers)
lib/camera             CameraProvider: BrowserCamera, MockCamera, shared grabFrame
lib/compositor         FrameDefinition types, coverCrop, composeFrame
lib/kiosk              pure state machine, session helpers, upload/consent client
lib/offline            IndexedDB queue store + UploadQueue (retry, dedupe, reload-safe)
lib/kiosk-auth         signed kiosk session cookie, enrollment, verification
lib/server             env validation, logging, rate limits, request helpers
lib/storage            PhotoService (all rules) + backends: memory, local files, Supabase
supabase/migrations    schema, RLS, private bucket
config/                kiosk knobs and frame definitions
tests/unit             Vitest (jsdom/node; FakeCanvas; fake-indexeddb)
tests/integration      real Supabase (npm run test:supabase)
e2e/                   Playwright (kiosk auth on; E2E_STORE=supabase optional)
```

## Working rules

- Keep kiosk rules in `lib/kiosk/machine.ts` (pure reducer) and test them there. Components only
  run effects and dispatch.
- Anything touching canvas takes a `CanvasFactory` so it is testable with `tests/helpers/fake-canvas.ts`.
- Kiosk copy: short Korean, large touch targets (`btn-primary`/`btn-secondary` are ≥ 80px tall).
- Storage rules live in `lib/storage/photo-service.ts` (+ `lib/ops`); backends stay dumb. New
  backend behaviour must pass `tests/helpers/photo-contract.ts` and `tests/helpers/ops-contract.ts`.
- Staff features need the Supabase backend. Local dev auth: `npx supabase start`, codes in Mailpit
  (`http://127.0.0.1:54324`). Admin E2E: `E2E_STORE=supabase` (see docs/ADMIN.md).
- Before committing: `npm run check`. Before claiming a flow works: `npm run test:e2e`. Touching
  Supabase code or migrations: also `npm run test:supabase`.
- Never claim the real-phone cellular test passed unless a human did it (see DEPLOYMENT).
- Develop without a camera via `/kiosk?camera=mock`.
- Never commit `.env*.local`, `.data/`, or guest photos.
- Don't call anything "production ready" without real-device verification (see ROADMAP).
