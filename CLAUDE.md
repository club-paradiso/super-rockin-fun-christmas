# CLAUDE.md — STUDIO SHALOM

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
- **Frames are data** in `config/frames/`. Don't hard-code layout in the compositor. Every frame
  keeps the legible lockup rule in `tests/unit/frames.test.ts`; mirror frame changes in Figma
  (`design/README.md`).
- **The brand is STUDIO SHALOM** (D73; lockup `STUDIO` / `SHALOM` / divider / `평화의 벽`, event
  "Christmas Village 2026", verse reference "MT 5:9" with no verse text). Colours are the tokens in
  `app/globals.css` (`backdrop`, `ink`, `button`, `button-text`/`paper`, `accent`, plus the staff
  status colours): no other brand colours, no gradients or glow, one filled button per view,
  `accent` as text only at ≥ 24 px, never `button-text` on `backdrop`. The on-screen lockup is real
  text (`components/brand.tsx`); frames use outlined SVG paths. The media wall keeps its night
  scene with its own `--wall-*` palette (`.wall-stage`). Internal identifiers keep the old name
  (`FTL_*`, `ftl_*`, IndexedDB `follow-the-lights`, wall browser profile folders, package name):
  renaming them breaks deployed hubs or loses queued uploads.
- **No secrets in the browser.** Never add `NEXT_PUBLIC_` to a secret. Kiosk auth is the
  HttpOnly cookie from `/kiosk/enroll`; the browser never talks to Supabase.
- **Private photos.** Bucket stays private; guests only ever see `/p/[token]`,
  `/p/[token]/image` and `/p/[token]/video`. Never return `objectPath`, `tokenHash` or signed
  storage URLs to clients.
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
  cookie MAC key is derived with a staff-only label. Booth help mode (`/api/kiosk/help`, D59)
  checks a staff PIN but issues no session; every PIN check goes through `attemptStaffPin`.
- **Every state change is audited atomically**: moderation, deletion, token rotation, kiosk
  rename/revoke, enrollment codes, settings, staff changes go through ONE backend call (a SQL
  `ftl_*` function on Supabase). Never update those columns directly.
- **Moderation rules live in `lib/ops/moderation.ts`.** APPROVED requires wall consent; DELETED is
  terminal and removes the image. No AI moderation, no face anything.
- **PAUSE SUBMISSIONS never blocks photography or QR delivery** — only new wall consent.
- **The wall only ever receives `wall_eligible_photos` ids**, through `/api/wall/feed`. PAUSE WALL
  and SHOW HOLDING SCREEN are applied on the server, and so are the opening hours (`wallOpen` in
  `lib/wall/hours.ts`, D62): outside them the feed is `closed` and sends no ids. Never give the
  wall anon database access, tokens or storage URLs.
- **Phone uploads (D66) are ordinary photos** with `frame_id = 'phone-photo'` (`config/mobile.ts`):
  one per booth QR (the signed `lib/mobile/token.ts` session id is the photo's unique
  `session_id`), re-encoded on the server (`lib/mobile/image.ts`: no EXIF/GPS), entering review
  as PENDING only through `PhotoService.putMobile` with explicit consent. No guest link, no QR
  reissue. Never add a path that makes one APPROVED or wall-visible outside `lib/ops/moderation.ts`.
- **Session video is best-effort and silent** (D72): never request or record audio. Recording
  (`lib/kiosk/recorder.ts`), its upload (`/api/photos/video`, not queued offline) and its cloud
  copy must never delay, block or fail photography, the photo upload, wall consent or the QR. MP4
  or WebM only, magic bytes checked, at most `KIOSK_CONFIG.videoMaxBytes` on the kiosk and on every
  route (413). Its object path is derived from the photo's (`videoPath`), so whatever removes a
  photo's image removes its video. No "video ready" UI unless the server has one. Phone uploads
  never have a video; the wall never receives a video, a video URL or a flag about one.
- **The cloud is only a QR copy** (D40, D43, D57) **plus a transient phone-upload inbox** (D66): the
  hub takes each phone photo (`HubInbox`) and the cloud deletes it on `ack`. A hub with `CLOUD_BASE_URL` shows the cloud's
  guest link and never stores it; consent, moderation and exposures never go to the cloud. All
  cloud calls go through `CloudSync` (one call per photo at a time: a second upload would reissue
  the token and kill a scanned QR). The session video follows the photo copy with `putVideo`, which
  never issues a token (D72). A hub delete must reach the cloud (`markDeleted`). The cloud's
  `/api/hub/*` only touches copies with `kioskId` null; a copy deleted there is final (410).
- **The dedicated wall address is a hostname, not a second app** (D68): `WALL_HOSTS` +
  `lib/wall/host.ts` in `next.config.ts`. No second database, no wall-only backend.
- **Easy mode is a view, not a fork** (D67): `mode` lives in `lib/kiosk/machine.ts`; never duplicate
  the shooting, selection, consent or upload rules for it.
- **The pose guide is a view too** (D71): `poseGuide` + `currentPose` in `lib/kiosk/machine.ts` only
  decide what the countdown shows. Poses are data in `config/poses.ts` (one per shot, text only; no
  invented art). Every shot counts `KIOSK_CONFIG.countdownSeconds` (10 s); easy mode is never
  shorter. `NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS` is for the E2E build only.
- **The booth language is a view too** (D78): `lang` in `lib/kiosk/machine.ts` (every guest
  starts in Korean). Every guest string lives in `lib/kiosk/copy.ts` in both languages; never
  hard-code booth copy in a component. Korean copy is the user's wording (D76). "이전" exists only
  where `canGoBack` allows it: never once a shot exists or the frame is final.
- **The booth is a letter** (D79): booth content sits on one `LetterSheet` (paper on the backdrop).
  The wax seal (`public/brand/wax-seal.webp`) is decoration only (`alt=""`, no pointer events,
  never over a button, never causing scroll) and is pressed on two screens only: the attract screen and
  the QR once it is real. The sheet is a faded diary page (D81): paper with 18 % backdrop, ink grain
  and accent ruled lines as SVG data URIs in `app/globals.css` (never CSS gradients); easy mode has
  no ruled lines.
- **The booth opens on "화면을 눌러 시작"** (D80): phase `attract` in `lib/kiosk/machine.ts` is the
  initial state and where every reset lands; only `OPEN` leaves it, to the welcome choices.
- **The O of SHALOM holds the star** (D77) on screen (`components/brand.tsx`) and in every frame
  lockup SVG (`id="o-star"`, checked in `tests/unit/frames.test.ts`).
- **Wall rotation is decided on the hub** by the pure `rotationOrder` (`lib/wall/rotation.ts`); the
  wall only picks the first usable id. Changing rotation means keeping F1–F6
  (`docs/ARCHITECTURE.md` 1.7) green in `tests/unit/rotation.test.ts`.

## The user's words

- **밤티**: Korean slang for "tacky, unrefined, ugly, not good enough" (a meme from an old avatar-game
  screenshot; its opposite in the same slang is "장원영"). "시안이 밤티" means the design still looks
  cheap or clumsy: push the craft further, do not defend the current version.

## Layout

```
app/kiosk              booth (server gate: config + enrollment) → components/kiosk
app/kiosk/enroll       staff device enrollment
app/p/[token]          phone download page + image and video routes (server reads private bucket)
app/m/[token]          "내 사진으로 참여하기" phone page (D66): pick, turn/crop, consent, upload
app/api/mobile         booth QR session + status (kiosk cookie), phone upload (QR token only)
lib/mobile             upload QR token, server re-encoding (sharp), phone-side resize/crop
app/api/photos         upload (kiosk auth, idempotent per session), consent, session video (D72)
app/api/kiosk          enroll / signout / help (booth help mode: kiosk cookie + staff PIN, D59)
                       · app/api/operator/kiosks: list / revoke
app/api/cron/retention retention cleanup (Bearer CRON_SECRET, Vercel Cron)
app/admin              staff control panel: login, (staff)/ pages (overview, moderation,
                       sessions, photos, kiosks, settings, audit)
app/api/admin          staff APIs (staffRoute: Supabase session + allowlist + CSRF)
app/api/kiosk/heartbeat kiosk liveness (kiosk cookie)
app/wall               media wall (server gate: config + enrolled display) → components/wall
app/api/wall           wall feed (ordered eligible ids) + exposure report + image proxy (kiosk cookie)
lib/wall               wall states, pure rotation order + scheduler, server feed (emergency switches),
                       clothesline layout + phone-photo card, watchdog, opening hours (D62),
                       dedicated wall hostname rules (host.ts, D68)
app/api/hub            cloud side of the hub's QR copy: put / reissue / delete / video (Bearer HUB_SYNC_SECRET),
                       and the phone-upload inbox: uploads/session|status|list|image|ack (D66)
app/api/photos/qr      kiosk asks again for a "QR 준비 중" photo (hub with a cloud)
lib/cloud              hub side: CloudClient (HTTP) + CloudSync (per-photo lock, queue, worker)
                       + HubInbox (phone photos down from the cloud inbox, D66)
lib/ops                moderation rules, enrollment codes, kiosk health, staff read models,
                       hub retention (D47/D58: rules in hub-retention.ts, timer in -server.ts),
                       USB backup + disk status (D60: backup.ts, backup-server.ts), event close (D64)
lib/staff-auth         staff sessions: Supabase Auth (cloud) or PIN + signed cookie (hub), setup code
proxy.ts               refreshes staff sessions for /admin pages (no authorization here)
components/admin       admin UI (cards, dialogs, emergency switches, kiosk/staff managers)
components/brand.tsx   the STUDIO SHALOM lockup and one-line wordmark as text (styles in app/globals.css)
lib/camera             CameraProvider: BrowserCamera, MockCamera, shared grabFrame
lib/compositor         FrameDefinition types, coverCrop, composeFrame
lib/kiosk              pure state machine, help-mode reducer, session helpers, upload/consent client,
                       booth copy in Korean and English (copy.ts, D78),
                       session video recorder (injected MediaRecorder, D72)
lib/video              video types, magic-byte check, byte ranges (shared by booth and server)
lib/offline            IndexedDB stores + UploadQueue and ConsentQueue (retry, dedupe, reload-safe)
lib/kiosk-auth         signed kiosk session cookie, enrollment, verification
lib/server             env validation, logging, rate limits, request helpers
lib/storage            PhotoService (all rules) + backends: memory, local files, Supabase
supabase/migrations    schema, RLS, private bucket
scripts                hub-start.mjs (launcher), hub-restore.mjs, event-check.mjs (read-only deletion
                       check), staff-add.mjs (plain Node, unit tested)
ops                    desktop-icon wrappers: start-hub / restore-backup / event-check (.bat/.command),
                       start-wall
config/                kiosk knobs, frame definitions, pose guide sequence (poses.ts, D71)
design/                Figma source link, Figma -> code mapping (README), page previews
tests/unit             Vitest (jsdom/node; FakeCanvas; fake-indexeddb)
tests/integration      real Supabase (npm run test:supabase)
e2e/                   Playwright (kiosk auth on; E2E_STORE=supabase optional; SCREENSHOTS=1)
measure/               Phase 4 measurements: seeded hub load + long wall run (playwright.measure.config.ts)
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
