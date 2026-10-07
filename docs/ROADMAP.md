# Roadmap

## Phase 0 — repository rebuild ✅

AFTERGLOW archived on `archive/afterglow-2026-10-07`. Next.js + TS + Tailwind, ESLint,
Prettier, Vitest, Playwright.

## Phase 1 — first vertical slice ✅ (headless Chromium only)

Mock/real camera → countdown → 4 captures → review/retake → frame → composite → local
download → QR → phone page → consent → reset.

## Phase 2 — secure public photo delivery ✅ software · ❌ real phone not verified

- Kiosk enrollment: HttpOnly signed session, revocable, sliding; operator list/revoke API.
- Supabase backend: private bucket, `photos`/`kiosks` with RLS and no policies, migrations.
- Upload hardening: auth, Origin, 4 MB streaming cap, MIME and magic bytes, UUID/frame checks,
  idempotency, rate limits.
- Public `/p/[token]` built from a validated `PUBLIC_BASE_URL`, identical 404s, save/share flow.
- IndexedDB offline queue with reload recovery; no fake QR.
- Retention cron; structured logs; CI (quality, E2E, Supabase integration).
- **Open gate:** deploy a preview and run the real-phone cellular test (`docs/DEPLOYMENT.md` §4).

## Phase 3 — moderation and staff (`/admin`) — next

1. **Staff authentication first**: Supabase Auth (email magic link or passkey) for a small
   allowlisted staff list, kept separate from the kiosk session. Retire the enrollment secret as
   the operator key.
2. Moderation queue: `PENDING` photos (wall_consent = true) with approve, reject, hide, restore and
   delete. Every transition is server-side and audited (who and when, in a `moderation_events`
   table). Delete removes the object immediately.
3. Kiosk management: list, revoke and rename kiosks; last seen; enroll via one-time codes instead of
   a shared secret.
4. Health: kiosk heartbeat (queue depth, auth state), storage usage, last retention run.
5. Emergency switches in one `settings` row: PAUSE SUBMISSIONS (consent screen hidden), PAUSE
   MEDIA WALL, SHOW HOLDING SCREEN.
6. "Show QR again" for a recent session: rotate its token and display a new QR on the admin
   device, which covers guests who left while their photo was queued.
7. Image delivery for staff via short-lived signed URLs from the server (never public).

## Phase 4 — media wall (`/wall`)

Night-village scene, `APPROVED AND wall_consent` only, `ENTER → VISIBLE → EXIT → COOLDOWN`,
polling or Realtime through a server endpoint (not anon table access), offline cache, and
BOOT/EMPTY/OFFLINE/MAINTENANCE states.

## Before the event (real hardware)

Real webcam under booth light; iPad/Safari kiosk (camera, full screen, sleep); MY4CUT Mini
(browser, camera, kiosk mode, auto start); phone matrix (iPhone Safari, Android Chrome, KakaoTalk
and Naver in-app browsers) on cellular; venue Wi-Fi failure drill.
