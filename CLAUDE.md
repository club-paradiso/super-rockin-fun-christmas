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
- **Staff = a session + an active staff row**, checked server-side on every page
  (`requireStaff`) and API (`staffRoute`), through `authorizeStaffRequest` / `getStaffForPage`.
  Cloud: Supabase Auth email OTP (a Supabase user alone is nothing; no signups). Hub
  (`FTL_ROLE=hub`): name + 6-digit PIN, scrypt-hashed in `StaffRepository.setPin`, never returned
  by `list()`/`get()`; first staff only via the console setup code (`lib/staff-auth/setup.ts`).
- **Kiosk and staff auth never substitute for each other.** Kiosk APIs read only the kiosk
  cookie; staff APIs read only the staff session (Supabase cookies or `ftl_staff`). The staff
  cookie MAC key is derived with a staff-only label.
- **Every state change is audited atomically**: moderation, deletion, token rotation, kiosk
  rename/revoke, enrollment codes, settings, staff changes go through ONE backend call (a SQL
  `ftl_*` function on Supabase). Never update those columns directly.
- **Moderation rules live in `lib/ops/moderation.ts`.** APPROVED requires wall consent; DELETED is
  terminal and removes the image. No AI moderation, no face anything.
- **PAUSE SUBMISSIONS never blocks photography or QR delivery** — only new wall consent.
- **The wall only ever receives `wall_eligible_photos` ids**, through `/api/wall/feed`. PAUSE WALL
  and SHOW HOLDING SCREEN are applied on the server. Never give the wall anon database access,
  tokens or storage URLs.
- **The cloud is only a QR copy** (D40, D43, D57). A hub with `CLOUD_BASE_URL` shows the cloud's
  guest link and never stores it; consent, moderation and exposures never go to the cloud. All
  cloud calls go through `CloudSync` (one call per photo at a time: a second upload would reissue
  the token and kill a scanned QR). A hub delete must reach the cloud (`markDeleted`). The cloud's
  `/api/hub/*` only touches copies with `kioskId` null; a copy deleted there is final (410).
- **Wall rotation is decided on the hub** by the pure `rotationOrder` (`lib/wall/rotation.ts`); the
  wall only picks the first usable id. Changing rotation means keeping F1–F6
  (`docs/ARCHITECTURE.md` 1.7) green in `tests/unit/rotation.test.ts`.

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
app/api/wall           wall feed (ordered eligible ids) + exposure report + image proxy (kiosk cookie)
lib/wall               wall states, pure rotation order + scheduler, server feed (emergency switches)
app/api/hub            cloud side of the hub's QR copy: put / reissue / delete (Bearer HUB_SYNC_SECRET)
app/api/photos/qr      kiosk asks again for a "QR 준비 중" photo (hub with a cloud)
lib/cloud              hub side: CloudClient (HTTP) + CloudSync (per-photo lock, queue, worker)
lib/ops                moderation rules, enrollment codes, kiosk health, staff read models
lib/staff-auth         staff sessions: Supabase Auth (cloud) or PIN + signed cookie (hub), setup code
proxy.ts               refreshes staff sessions for /admin pages (no authorization here)
components/admin       admin UI (cards, dialogs, emergency switches, kiosk/staff managers)
lib/camera             CameraProvider: BrowserCamera, MockCamera, shared grabFrame
lib/compositor         FrameDefinition types, coverCrop, composeFrame
lib/kiosk              pure state machine, session helpers, upload/consent client
lib/offline            IndexedDB stores + UploadQueue and ConsentQueue (retry, dedupe, reload-safe)
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
- Staff features run on the hub (`FTL_ROLE=hub PHOTO_STORE=local`, PIN login; the setup code is
  printed in the server console) or on Supabase (`npx supabase start`, codes in Mailpit
  `http://127.0.0.1:54324`). `npm run test:e2e` runs as the hub; `E2E_STORE=supabase` runs the
  cloud admin specs (see docs/ADMIN.md).
- Before committing: `npm run check`. Before claiming a flow works: `npm run test:e2e`. Touching
  Supabase code or migrations: also `npm run test:supabase`.
- Never claim the real-phone cellular test passed unless a human did it (see DEPLOYMENT).
- Develop without a camera via `/kiosk?camera=mock`.
- Never commit `.env*.local`, `.data/`, or guest photos.
- Don't call anything "production ready" without real-device verification (see ROADMAP).
