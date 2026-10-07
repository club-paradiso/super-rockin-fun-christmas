# Roadmap

## Phase 0 — repository rebuild ✅

AFTERGLOW archived on `archive/afterglow-2026-10-07`; Next.js + TS + Tailwind, ESLint,
Prettier, Vitest, Playwright, env template, docs.

## Phase 1 — first vertical slice ✅ (verified in headless Chromium only)

Mock/real camera → countdown → four captures → review/retake → frame → final composite →
local download → QR → phone page → consent → complete → reset.

## Phase 2 — public phone delivery (next)

1. `SupabasePhotoStore` implementing `PhotoStore` (private bucket, rows keyed by token hash,
   short-lived signed URLs served through `/p/[token]/image`, never raw bucket paths).
2. Kiosk authentication for uploads (per-device secret held server-side, or a signed kiosk
   session) — required before the API is public.
3. Retention job deleting expired photos (`PHOTO_RETENTION_DAYS`).
4. Offline resilience, kept small: queue the final JPEG in IndexedDB when upload fails, retry in
   the background, and let staff see "N pending uploads". Same session id → no duplicates.
5. Deploy (e.g. Vercel + Supabase) and test QR from real phones on cellular data.

## Phase 3 — moderation (`/admin`)

Staff auth (Supabase Auth, staff-only), pending queue, approve/reject/hide/restore/delete,
recent sessions, kiosk/wall/storage health, emergency switches (pause submissions, pause
wall, holding screen) stored as one settings row.

## Phase 4 — media wall (`/wall`)

Night-village scene; approved photos arrive in lit windows (`ENTER → VISIBLE → EXIT →
COOLDOWN`), fair rotation, BOOT/EMPTY/OFFLINE/MAINTENANCE states, polling or Realtime, cached
last-known set for offline.

## Before the event (must verify on real hardware)

- Real USB webcam: resolution, exposure under booth light, mirror expectation with guests.
- Tablet/iPad Safari: `getUserMedia`, full-screen/kiosk mode, auto start, sleep prevention.
- MY4CUT Mini: browser availability, camera access, kiosk mode, auto start, export.
- Venue Wi-Fi failure drill; QR scanning distance and lighting; accessibility with older adults.

## Order review

The suggested order (QR delivery → Supabase → consent → moderation → wall) is kept with one
change: **consent UI already exists and records `PENDING`, so the real next step is Supabase
storage + kiosk upload auth together**, because QR delivery is only useful once phones can reach
the photos from the internet, and an open upload endpoint cannot go public. Moderation must ship
before the wall shows anything, so Phase 3 strictly precedes Phase 4.
