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

## Known limitations

- Rate limiting is per serverless instance.
- A guest who leaves while their photo is still queued gets no QR. The photo uploads later and
  can only be re-shown by a Phase 3 admin tool.
- The queue assumes one kiosk tab per device. Two tabs cannot duplicate a photo (the server is
  idempotent), but the second tab's response would rotate the first tab's token.
- Queue entries are never expired client-side. Staff see the count and can clear site data if
  they really must.
