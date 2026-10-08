# Architecture

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
    as `…​.thumb.jpg`.
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
  - `pause_wall` and `show_holding_screen` are stored for Phase 4.
- **Phase 4 source of truth:** the `wall_eligible_photos` view (APPROVED ∧ wall_consent ∧ not
  deleted, service_role only) and `isWallEligible()`.

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
