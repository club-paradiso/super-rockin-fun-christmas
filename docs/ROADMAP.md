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

## Phase 3 — staff operations (`/admin`) ✅ software · ❌ real staff devices not verified

- Staff login: Supabase Auth email OTP + `staff_members` allowlist; no signups; deactivation is
  immediate.
- Moderation queue (consented + pending, oldest first), photo library with filters, a strict
  server-side state machine, atomic append-only audit.
- Delete: removes the image and thumbnail, kills the guest link, terminal and idempotent.
- Recent sessions (≤ 24 h) and "QR 다시 보여주기" (audited token rotation).
- Kiosks: one-time enrollment codes (15 min, single use, hashed), rename and revoke (audited),
  heartbeat with online/stale/offline, queue depth.
- Emergency switches: pause submissions (enforced now), pause wall and holding screen (stored for
  Phase 4). Health overview shows measured values only.
- Staff image proxy with `sharp` review thumbnails; RLS still denies anon/authenticated
  everything.
- CI: staff auth, admin APIs and admin E2E run against a local Supabase (Auth + Mailpit) in
  Docker.

## Phase 4 — media wall (`/wall`) — next

Consume `wall_eligible_photos` through a server endpoint (no anon table access). Respect
`pause_wall` and `show_holding_screen`. Wall display auth: probably a kiosk-like enrolled display
device rather than staff login.

Night-village scene, `APPROVED AND wall_consent` only, `ENTER → VISIBLE → EXIT → COOLDOWN`,
polling or Realtime through a server endpoint (not anon table access), offline cache, and
BOOT/EMPTY/OFFLINE/MAINTENANCE states.

## Before the event (real hardware)

Real webcam under booth light; iPad/Safari kiosk (camera, full screen, sleep); MY4CUT Mini
(browser, camera, kiosk mode, auto start); phone matrix (iPhone Safari, Android Chrome, KakaoTalk
and Naver in-app browsers) on cellular; venue Wi-Fi failure drill.
