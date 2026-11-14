# Decision log

## D1 · Archive AFTERGLOW on a branch, not in-tree (2026-10-07)

`archive/afterglow-2026-10-07` points at `71a6e62`. The product tree contains only FOLLOW THE
LIGHTS. `main` was created at the same commit as the base for this transition.

2026-10-15: the brand is final (FOLLOW THE LIGHTS), so the owner had the earlier project's traces
removed: the README history section, and the branches `archive/afterglow-2026-10-07` and
`claude/interactive-music-media-design-qnq5m9`. Their commits are still in `main`'s history.

## D2 · Boring stack

Next.js 16 App Router + TypeScript strict + Tailwind 4. One app, three surfaces. Supabase planned
for storage/auth/DB in Phase 2; not wired in Phase 1 so the camera flow was not blocked on it.

## D3 · Local disk PhotoStore in Phase 1

Gives a working QR → phone path today on a LAN and pins down the `PhotoStore` interface that
Supabase will implement. Not suitable for public deployment.

## D4 · No printing

Product decision. Delivery is QR → guest's own phone.

## D5 · Mirror the saved photo

Guests read the preview like a mirror; the saved photo matches what they saw. One flag
(`KIOSK_CONFIG.mirror`) drives both, so they cannot drift. Revisit after real-guest testing
(text on clothing reads reversed).

## D6 · One capture aspect (4:3) for every frame

Frame is chosen after shooting, so the preview crop must be valid for all frames. Tests enforce
that every slot is 4:3. The compositor still cover-crops defensively.

## D7 · Frames as data, deterministic rendering

`FrameDefinition` objects in `config/frames/`. Decorative randomness uses a seeded PRNG. Dates
are formatted in Asia/Seoul.

## D8 · Pure reducer for the kiosk

All session rules in `lib/kiosk/machine.ts`; React effects only perform I/O. This is what makes
"exactly four captures" and "reset clears everything" testable without a browser.

## D9 · Camera abstraction with a mock

`CameraProvider` with `BrowserCamera` and `MockCamera`. CI and AI sessions have no camera; E2E
also runs the real `getUserMedia` path against Chromium's fake device.

## D10 · Tokens: 192-bit random, stored hashed, expiring

Unguessable and non-sequential; a leaked data folder does not leak working links.

## D11 · Session id as upload idempotency key

Retries after a dropped response return the same token — no duplicate photos.

## D12 · JPEG 0.92 output

Phone-friendly size (≈0.3–1 MB) versus multi-MB PNG.

## D13 · MY4CUT is a shell only

No vendor API is assumed or imitated until verified on the device.

## D14 · Dev-only audit advisory accepted

`npm audit` reports a `braces` ReDoS advisory via `eslint-config-next` → `fast-glob`. Lint
tooling only, not shipped to the browser or server; revisit when upstream updates.

## D15 · Main branch

`main` exists on the remote (created from the AFTERGLOW head). Making it the GitHub default
branch is a repository setting that must be changed by an owner.

---

# Phase 2 decisions (2026-10-07)

## D16 · Phase 2 branched from the PR #3 head, not main _(historical)_

_Historical record. As written on 2026-10-07:_ PR #3 (Phase 1) was not merged and `main` was still
the AFTERGLOW commit, so Phase 2 was built on `claude/follow-the-lights-phase-2`, branched from the
exact PR #3 head (`12f14e6`), and PR #4 initially targeted the Phase 1 branch.

**Resolved (2026-10-07):** PR #3 merged into `main` (merge commit `5140395`), PR #4 was retargeted
to `main` and merged (merge commit `7fda0eb`). `main` now contains Phase 1 and Phase 2. All later
work branches from `origin/main` explicitly (the GitHub default branch setting may lag).

## D17 · Kiosk auth = enrollment secret typed by staff → HttpOnly signed session + revocable row

No secret is ever in browser JS. An HMAC-signed cookie avoids a session-table lookup for
validity, but the kiosk row is still checked on each use so revocation is immediate. MDM, device
certificates and per-device keys are out of proportion for 1–3 kiosks. `SameSite=Lax` plus Origin
checks (Strict breaks launcher links).

## D18 · Browser never talks to Supabase

All access goes browser → Next.js route → service-role client. RLS is on with no policies and
grants are revoked from anon/authenticated. No anon key in the frontend at all.

## D19 · Serve images through the server, not signed URLs

`/p/[token]/image` reads from the private bucket and streams the bytes. The photo's public
identity is the token URL. Storage URLs (signed or not) never reach a client. Cost: bytes pass
through a function, which is fine at ≤ 4 MB and event scale.

## D20 · Retry = same row, new token (raw tokens never stored)

Phase 1 kept the raw token to return it on retries, which violated "raw token never stored".
Now a retry of an active session from the same kiosk rotates the token on the one existing row.
This is safe because a retry only happens when the kiosk never received (and so never displayed)
the earlier token. Other kiosks get 409.

## D21 · One PhotoService, three backends, one contract

Rules live in one place. Memory, local-file and Supabase backends all run the same contract
tests, and the Supabase one runs against a real local stack (Docker) in CI.

## D22 · Upload cap 4 MB

Vercel functions reject request bodies over 4.5 MB. A 1200×3600 JPEG at q=0.92 is ~0.3–1.5 MB.

## D23 · IndexedDB queue for every delivery

Persist first, then upload, so a dropped connection or a reload never loses a finished photo.
The QR is only shown from a real server token. Single in-flight upload per session plus
server idempotency means no duplicates.

## D24 · Retention via Vercel Cron + protected route

Boring and already in the stack. It's daily (the Hobby plan limit), idempotent and bounded per
run. No worker process.

## D25 · In-process rate limits, no Redis

Event scale is one to three kiosks. Limits are per instance on serverless (documented). The
security does not depend on them.

## D26 · Production config fails loudly

Strict mode rejects localhost/LAN/http QR origins, weak secrets and disabled auth. The kiosk
shows a staff error screen and the boot log says `config_invalid`. `FTL_ALLOW_LOCAL_ORIGIN` exists
only for the E2E production build and is ignored on Vercel.

---

# Phase 3 decisions (2026-10-07)

## D27 · Staff = Supabase Auth email OTP + server-side allowlist

Email codes are typed (not magic links), so they work when the email opens on a different
device than the admin screen. `enable_signup = false` plus `shouldCreateUser: false` means
accounts only come from `npm run staff:add` or **설정 → 스태프 추가**. Authorization is an active
`staff_members` row checked on every request; a valid Supabase session alone grants nothing.
There is one role (`role` column reserved for later).

## D28 · Codes are sent only to active staff; responses never differ

This prevents account enumeration. The OTP endpoint is rate-limited per IP and per email.

## D29 · Audited mutations are SQL functions

`ftl_photo_transition`, `ftl_photo_rotate_token`, `ftl_kiosk_update`,
`ftl_enrollment_code_create/consume`, `ftl_settings_update` and `ftl_staff_upsert` each change
state and append to `audit_events` in one transaction. The audit log is append-only (trigger + no
UPDATE/DELETE grant). Memory and local backends mirror this with one serialized operation. One
generic `audit_events` table (subject_type photo/kiosk/enrollment_code/settings/staff) replaces
separate per-domain tables; moderation history is its `subject_type = 'photo'` rows.

## D30 · Rules in TypeScript, invariants also in the database

The transition table lives in `lib/ops/moderation.ts`. The database independently refuses
APPROVED without consent and any change out of DELETED.

## D31 · Delete = tombstone first, then remove bytes

The row becomes DELETED first, so the guest link dies even if storage is briefly down. Then the
objects are removed and `object_deleted_at` is set; retention retries leftovers. The row stays as
an audit tombstone with no image and no working token.

## D32 · Staff images through a server proxy, thumbnails via sharp

No signed URLs reach browsers. Review thumbnails (~640px JPEG) are made at upload, or lazily for
Phase 2 photos, so grids load tens of KB per photo instead of ~1 MB.

## D33 · One-time kiosk enrollment codes replace the shared secret

8 symbols from a 31-letter alphabet (~40 bits), 15 min, single use, SHA-256 stored, rate-limited.
`KIOSK_ENROLL_SECRET` is now optional legacy (leave empty in production).

## D34 · Heartbeat carries the pause flag back

The kiosk learns `pause_submissions` from page load, heartbeats (45 s) and every upload
response. The server enforces it regardless (consent YES → 409).

## D35 · Recent sessions are time-boxed

The default view is 6 h (max 24 h on that page), found by time, kiosk or the 8-character session
code shown on the kiosk. This is recovery, not browsing; there is no face or person search.

## D36 · The wall display is an enrolled device, like a kiosk

The wall browser enrolls with the same one-time code (`/kiosk/enroll?next=wall`) and gets the same
HttpOnly signed session, so it can be revoked from /admin and its heartbeat shows it online. No
second auth system, no staff login on a public screen. Cost: an enrolled wall could also call the
kiosk upload API; acceptable because both devices are staff-placed and revocable, and the wall
never receives tokens or storage paths. A device `role` can be added later if that matters.

## D37 · The wall polls a server feed; the server applies every rule

`/api/wall/feed` reads `wall_eligible_photos` (APPROVED + consent + not deleted) with the service
role and returns ids only. PAUSE WALL and SHOW HOLDING SCREEN are applied there: the wall is sent
no photo ids at all. `/api/wall/photos/[id]/image` re-checks the row on every request. Polling
(10 s) instead of Realtime: no anon database access, and one poll is the upper bound for a hidden
or deleted photo to leave the screen.

## D38 · Offline cache with a time limit

The wall keeps eligible images as in-memory object URLs and keeps showing them through short
network loss. After `offlineGraceMs` (2 min) without a successful poll it drops them all, because
it can no longer learn about hides or deletions. Images are the ~640px review JPEG, small enough
for venue Wi-Fi.

---

# Phase 1 (local-first) design decisions (2026-10-12)

_Proposed in `docs/ARCHITECTURE.md` part 1. Not implemented yet. Rationale and rejected
alternatives are in that document, section 1.3._

## D39 · Still no printing

Confirmed by the owner on 2026-10-12. D4 stands.

## D40 · The on-site hub is the source of truth; the cloud is a QR-only copy

The same Next.js app runs as `FTL_ROLE=hub` on a venue laptop (local file backend) and as
`FTL_ROLE=cloud` on Vercel + Supabase. Capture, consent, moderation, the wall and the emergency
switches work without internet. The cloud holds only the photo and the token hash for phone
downloads, never consent or moderation data.

## D41 · Hub runs on the booth laptop

Camera access and `crypto.randomUUID` need a secure context; `localhost` is one, a LAN `http://`
address is not. A tablet booth would need a locally trusted HTTPS certificate instead.

## D42 · Dedicated router for the event LAN

Wall and staff devices reach the hub over plain HTTP, so cookies cannot be `Secure`. The LAN is a
dedicated, password-protected router, never the congregation's Wi-Fi.

## D43 · Hub → cloud through a narrow, secret-authenticated API

`/api/hub/*` on the cloud can upload, delete and reissue a token, nothing else. The Supabase
service-role key never leaves the cloud deployment, so a lost laptop leaks less.

## D44 · Staff sign in with name + PIN on the hub

Email codes need internet. PINs are scrypt-hashed, rate-limited and revocable, and every action
stays audited per person.

## D45 · Keep the JSON file database until measured otherwise

It already passes the photo and operations contracts. Switch to SQLite only if a save at 5,000
photos and 20,000 audit events takes more than 200 ms.

## D46 · Fair rotation is ordered on the hub, with a persisted exposure log

Order: show-now requests, then never-shown photos in approval order, then fewest exposures and
oldest last exposure. Replaces "newest 60" (which starved older photos). Numeric criteria F1–F6
are in `docs/ARCHITECTURE.md` 1.7. Feed poll goes from 10 s to 5 s to meet the plan's
"hidden within 5 s".

## D47 · Retention defaults follow the 2026-10-07 plan, pending the church

QR link 24 h; photos not on the wall 24 h; wall photos until `eventEndAt` + 24 h. All are
settings. The under-14 rule is not implemented until the church decides; until then staff do not
approve photos showing children without guardian confirmation.

## D48 · Frame choice stays after capture

All frames share 4:3 slots (D6), so the choice can come later and the guest has one less
decision before shooting. A setting can move it before capture.

---

# Phase 2 decisions (2026-10-12)

## D49 · First hub staff member via a console setup code

A fresh hub has no staff, so someone must create the first one without a terminal. While the hub
has no staff it prints a one-time code in its own console window; whoever can read the booth
laptop's screen can claim it at `/admin/login`. It is single use, rate-limited and same-origin.
The E2E suite may fix the code with `FTL_HUB_SETUP_CODE`, honoured only with the E2E-only
`FTL_ALLOW_LOCAL_ORIGIN` flag and never on Vercel.

## D50 · Only wrong PINs count toward the per-person limit

Staff log in on several devices; counting successes would lock them out. Five wrong PINs per
person per 15 minutes, keyed by staff id so it does not depend on spoofable `x-forwarded-for`.

## D51 · The default local E2E run is the hub

The hub is the event configuration, so `npm run test:e2e` now runs with `FTL_ROLE=hub`. The
existing kiosk, offline, security and wall specs pass unchanged; `e2e/hub.spec.ts` adds PIN login
and the capture → consent → approve → wall → hide flow without Supabase. `E2E_STORE=supabase`
still runs the cloud admin specs.

## D52 · Rotation state lives on the hub only

Exposures and show-now requests are kept by the hub's local backend. The Supabase backend does not
persist them (`exposures()` returns null), and a cloud wall falls back to the old newest-first
rotation (`ordering: "newest"`). The wall runs on the hub (D40), so a migration for a legacy path
is not worth its code.

## D53 · Exposure reports are saved within 30 s, everything else at once

The wall reports every few seconds; rewriting the whole local database file each time would be
wasteful. A crash loses at most 30 s of exposure counts, which only nudges the order. Staff
actions (show-now included) and all audited changes are still saved before they return.

## D54 · Never-shown photos wait in capture order

The design said approval order, but rows do not record when they were approved. Capture order
keeps the same guarantee (a new photo never jumps one that was already waiting) without a schema
change.

## D56 · The wall answer is queued by session id, like the photo

The kiosk stores the guest's answer in IndexedDB (`consents`, database v2) and sends it by
session id once that session's photo has left the upload queue, retrying across network loss and
reloads (AUDIT R1/R2). Session ids, not tokens, so no guest link is ever stored on the kiosk. The
server accepts it only from the kiosk that uploaded the session, under the same rules as before
(YES → PENDING, refused while submissions are paused), and still after the guest link has
expired. When the photo is still queued, the kiosk now continues to the wall question
("QR 없이 다음으로") instead of ending the session without asking.

## D55 · Feed = top of the order + what is on screen

Sending only the top `max(4S, 30)` keeps the response small with thousands of photos. A photo goes
to the back of the order as soon as it is reported shown, so the wall sends `?on=` and the hub
keeps those ids in the answer while they are still eligible; otherwise the safety rule would pull
a photo off the wall halfway through its turn.

## D57 · The QR copy: upload on demand, retry in the background, never store the guest token

On a hub with `CLOUD_BASE_URL`, an upload stores the photo on the hub and then sends the copy to
the cloud within the same request (`CLOUD_SYNC_TIMEOUT_MS`, default 8 s). The cloud answers with
its own guest link, which goes straight to the kiosk; the hub keeps only the copy's state
(`PENDING`, `SYNCED`, `DELETE_PENDING`, `DELETED`) and never the token. If the cloud cannot be
reached, the kiosk gets 202 "QR 준비 중" and asks `/api/photos/qr` every 3 s; a background worker
(every 15 s, backoff 5 s to 5 min) uploads copies nobody is waiting for.

- **One cloud call per photo at a time.** A second upload of the same session makes the cloud
  issue a new token and kill the QR the guest may have just scanned, so the kiosk's QR request and
  the worker take a per-photo lock.
- **Asking again reissues.** A copy already in the cloud gets a fresh token instead of a second
  upload, also when its link had expired, up to the cloud's retention. A copy the cloud deleted
  (its retention, or a hub delete) answers 410 and stays deleted: DELETED is terminal there too,
  and staff see "QR 서버의 보관 기간이 끝났어요" instead of "try again". Only a copy the cloud has
  no record of at all (a replaced database) is uploaded again.
- **Deletes follow.** A staff delete on the hub queues the cloud delete; it is sent at once and
  retried until the cloud confirms. A photo deleted before its copy ever arrived still sends the
  delete, because a lost response may have stored it.
- **The cloud copy has no kiosk** (`kiosk_id` null), and `/api/hub/*` refuses to touch photos a
  kiosk uploaded to the cloud directly. Cloud deletes are audited as `system` / `hub_delete`.
- **No consent, moderation or exposure data goes to the cloud** (D40). Staff "QR 다시 보여주기" on
  the hub reissues the cloud link and is audited on the hub; while the cloud is unreachable it
  answers 503 rather than showing a hub link a phone cannot open.

## D58 · Hub retention runs in the hub process, by moderation state

D47 implemented. Every 10 minutes while the hub runs (and 30 s after it starts):

- **Never on the wall** (NONE, PENDING, REJECTED): deleted `HUB_UNPOSTED_HOURS` (24) after
  capture. A photo still waiting for review at 24 h is deleted too, as planned.
- **On the wall** (APPROVED, and HIDDEN, because staff may show a hidden photo again): deleted at
  `EVENT_END_AT` + `HUB_WALL_GRACE_HOURS` (24).
- **Ceiling:** nothing outlives `PHOTO_RETENTION_DAYS` after capture, whichever comes first. With
  no `EVENT_END_AT` the ceiling is the only rule for wall photos, so a missing setting never keeps
  photos longer.

These are environment settings for whoever sets up the hub, not staff switches: retention is a
privacy commitment and should not change mid-event. The overview shows the rules as configured.
Deletes are the usual tombstone-then-bytes, audited as `system` / `retention_delete` with the
rule as the note. Cloud copies are queued (`CloudSync.queueDelete`) instead of sent one by one,
so a run while offline does not wait on one timeout per photo; the sync worker sends them.
The final values still wait for the church (STATUS, 10/16).

## D59 · Staff help mode unlocks the booth's own menu, never a staff session

A 3-second hold on the booth's top-left corner (a guest's tap never opens it), then the staff
member's name and PIN. `/api/kiosk/help` needs the kiosk cookie and checks the PIN on the hub,
counting wrong PINs against the same per-person limit as the staff login (5 per 15 min, shared
process-wide). It answers with the name only: no cookie and no staff session, so the booth can
never act as staff. The menu acts on the booth itself: camera choice, its upload and consent
queues ("지금 다시 보내기"), start over, reload. It closes after 60 s without a touch. On the hub
the camera choice moves from the guests' ready screen into this menu; cloud kiosks keep it where
it was. Hub only: cloud staff have no PINs.

## D60 · Operations tools: a Node launcher, a mirrored USB backup, warnings on the overview

- **Launcher:** `scripts/hub-start.mjs` (plain Node, so it runs without a build step and is unit
  tested) builds once, runs `next start` on all interfaces, restarts it when it stops (1 s up to
  30 s), prints the addresses for staff phones and the wall, and opens the booth in Chrome or Edge
  kiosk mode with its own profile. A second start finds the hub already up and only reopens the
  booth. `ops/*.bat` and `ops/*.command` are thin wrappers for the desktop icons; no pm2 or
  Windows service (D41: borrowed laptops).
- **Wall PC:** Chrome or Edge only, no Node. `ops/start-wall.*` reopens the browser when it closes;
  a close within 10 s means another wall window already holds the profile, so it stops instead of
  stacking windows. The hub address lives in `ops/wall-hub.txt`.
- **Backup:** every `HUB_BACKUP_MINUTES` (10) and on "지금 백업", a mirror to
  `HUB_BACKUP_DIR/ftl-backup`: a consistent `db.json` snapshot plus the image files. Deleted photos
  leave the backup on the next run, so the stick never keeps a photo longer than the hub. If the
  folder is missing (stick not plugged in) it fails loudly rather than writing to the laptop.
  `.env.local` is not backed up: the spare laptop gets its own copy.
- **Restore:** `scripts/hub-restore.mjs` never deletes; the current data folder is renamed aside.
- **Overview:** last backup, failure reason, free space on the laptop and the stick, with a warning
  below `HUB_DISK_WARN_MB` (2048) or when no backup finished within three intervals. Warnings only:
  a full disk makes uploads fail, and the booth's queue keeps those photos until there is room.

## D61 · The wall scene adapts to the LED shape instead of waiting for its resolution

The LED's input resolution is still unknown, and the plan said not to fix a layout without it.
Rather than guess one, the clothesline scene is built from shares of the canvas
(`WALL_CONFIG.scene`): every photo is half the canvas height, and the number of photos follows
the width (16:9 → 3, 32:9 → 8, 4:1 → 9, at most 10). The canvas is `WALL_CANVAS` on the hub, or
`?canvas=WxH` to try a size at the LED, or the screen itself. Tests check every candidate shape
(inside the window, on the line, no overlap), and E2E opens each one with real approved photos.
What only the real LED can answer is readability at viewing distance; `photoHeight` is the knob.

- The wall tells the hub its photo count (`/api/wall/feed?slots=`), so the feed is sized for it.
- The wall image is its own copy, long edge 1400 px (`WALL_CONFIG.imageLongEdge`), made on first
  request and kept next to the original as `<photo>.wall.jpg`; it is deleted with the photo like
  the thumbnail. The 640 px staff thumbnail is no longer sent to the wall.
- Low-spec mode (`WALL_LITE=1`, `?lite=1`): fades only, no twinkling, at most 4 photos.
- Watchdog: reload when no animation frame for 10 s while visible or after an unhandled error,
  at most once a minute (`sessionStorage`), plus a planned reload at 05:00. The viewport is
  measured after mount so the server render and the first client render agree; a hydration
  mismatch would count as an error and trigger a reload.
- Not yet: opening hours (`wallHours`, needs a settings migration) and frame-rate / memory in the
  wall heartbeat. Both are 2-4b.

## D62 · Opening hours are a setting with a staff override, applied by the hub

`wallHours` (one daily window, "HH:MM" in `WALL_CONFIG.timeZone` = Asia/Seoul, may run past
midnight) and `wallForce` (`auto` follows the hours, `on` / `off` override them) live in the event
settings, changed through the same single audited call as the emergency switches
(`ftl_settings_update`, now with the hours; migration `20261013090000_phase2_wall_hours.sql`).
The hub applies them on every feed poll: outside the hours the feed is `closed` with no photo
ids and the image route refuses, exactly like PAUSE WALL. Order: holding screen, then pause, then
closed. No hours = always open, so nothing changes until staff set them.

The wall's heartbeat now carries its frame rate (animation frames between heartbeats) and, in
Chromium, its JS heap in MB. Stored on the kiosk row (`frame_rate`, `memory_mb`), shown in
/admin → 키오스크, with a hint below 20 fps to use low-spec mode. Out-of-range values are dropped.

## D63 · One brand font, shipped with the app; the Figma file is the editable source

The frames' text is drawn on a canvas, and a canvas does not wait for web fonts: before this, the
"FOLLOW THE LIGHTS" mark came out in whatever font the borrowed laptop had (Malgun Gothic,
Apple SD Gothic Neo, or a plain sans), so the same frame looked different on every booth. Now
Noto Sans KR (variable, OFL-1.1) is bundled with the app (`@fontsource-variable/noto-sans-kr`),
served by the hub itself, so it also works with no internet. The kiosk loads exactly the
weights, sizes and characters its frames draw (`lib/compositor/fonts.ts`) and composes the final
photo only after that settles. If loading fails, it still composes with the fallback font rather
than block a guest. The same family is the UI font and the Figma font.

The wordmark has a legibility rule that `tests/unit/frames.test.ts` checks for every frame:
weight at least 700, size at least 4.5% of the output width, letter spacing 10–25% of the size, fits in 90% of
the width, below every photo, contrast at least 4.5:1 against the background. The snow-paper strip's
mark went from 800 to 700 for this (heavier strokes clog first at small sizes; Figma's Noto Sans
KR has no 800 either).

Design source: Figma file `S5hz7sZaXXB2kNc9YrB3cB` (tokens as variables, text styles, logo,
the three frames as components at real pixel size, wall scenes built from `clotheslineLayout`
numbers, booth and admin screens, signage with English plus Hangul pronunciation). It is not
synced automatically; `design/README.md` maps each Figma layer to the code that must change, and
`design/previews/` keeps a snapshot for anyone without Figma access.

## D64 · Closing the event is one staff action; checking the deletion is a read-only script

The automatic deletion (D58: wall photos at EVENT_END_AT + 24 h) needs the hub switched on at
that time, and nobody can see from the outside that it happened. Phase 5 adds two things.

- **"행사 종료 처리"** (admin → 설정, hub only, `lib/ops/event-close.ts`). Refused before
  EVENT_END_AT when that is set; the phrase "행사 종료" must be typed, then confirmed. One audited
  settings change stops new wall submissions and the wall, then every photo still on the hub is
  deleted the usual way (tombstone, then bytes), audited per photo as `event_close_delete` by the
  staff member who pressed it, and each cloud copy is queued for deletion. Running it again is
  harmless. There are no staff roles, so any signed-in staff member can press it; the typed
  phrase, the event-end gate and the per-photo audit are the guard.
- **`scripts/event-check.mjs`** (desktop icon "삭제 확인"). Read-only: photos not yet deleted,
  cloud deletes not yet sent, photo files, old `.before-restore-*` folders (the restore script
  never deletes, so these hold photos too), the USB mirror and the booth browser profile. Exit 0
  only when all are empty. Deleting folders stays a human step in RUNBOOK 8: the script never
  deletes, so a wrong path can never wipe the wrong disk.

## D65 · The booth follows the updated Figma: frame first, wall question before the QR

Source: Figma file `ZbeBrS0o5012SNFrGZNyIU` (pages `01 Platform — Booth & Admin`,
`02 네컷 Templates`), confirmed by the user on 2026-10-14. It replaces the 2026-10-13 file of D63
as the design source.

- **Order.** Attract → frame → shoot → review → frame again with the guest's own photos (the first
  choice preselected) → media-wall question → QR. Choosing first gives the guest something to look
  forward to; seeing their photos in each frame lets them change their mind cheaply. Progress shows
  as `N / 6` (`N / 5` while submissions are paused and the question is skipped).
- **Wall question before the QR.** The upload starts the moment the frame is final, so it runs while
  the guest answers and the QR is usually ready at once. The answer still never touches the
  download (`lib/kiosk/machine.ts`: delivery events are accepted on both screens; consent only
  moves the guest on). The QR screen is the last one: "다 받았어요" or the idle timer return to the
  attract screen. The "complete" screen and the kiosk-side file download are gone.
- **Four frames,** Templates A–D (남색, 창틀, 빨랫줄, 크림), replacing the three earlier ones. They are
  designed at 600 × 1800 and saved at 2× so photos stay sharp on a phone. Retired frame ids are
  still accepted on upload (`isKnownFrameId`), so a photo waiting in a kiosk queue or coming from a
  not-yet-updated hub is never refused.
- **Figma artwork as SVG, not new fonts.** Every frame carries the same wordmark (Brand/Lockup):
  gold on the navy frames, navy with an amber star on the cream ones. It and the Latin lines
  (Fraunces, Caveat) are exported from Figma as outlined SVGs under `public/frames/` and drawn by the
  compositor as `image` decorations, preloaded like the brand font (`lib/compositor/assets.ts`).
  The only live text left is Korean in Noto Sans KR (D63). The frame format gained photo layers
  (so a clothesline can cross the photo above it), rotation (the polaroids' tilt) and shadows.
- **One deliberate difference from Figma.** The wall question says "사진은 정해진 기간이 지나면
  지워져요." instead of "행사가 끝나면 지워져요": retention does not do that yet, and the period
  waits for the church's privacy decision.
- **Hiding from the wall asks first and can be undone for 5 seconds** (Figma A2/A3). `NONE` reads
  "미디어월 안 띄움", and the audit log shows Korean state names.
- **The wall is the Figma picture.** `03 Media Wall` → `Wall/Background — v3` (the window on Jeju at
  11 p.m., with the line and the wordmark in it) is one bundled 3840 × 1080 JPEG, and five strips
  hang at the clip points of `Composite preview v3` (`config/wall.ts` `scene`). This replaces D61's
  drawn scene whose photo count followed the screen shape: the scene now keeps its size and is
  fitted to any screen without stretching (black bands on other shapes). Timings are unchanged
  (enter/exit 1.5 s, visible 14 s, cooldown 60 s). Low-spec mode keeps four slots (no middle one).
- **iPad portrait.** `01b Platform — iPad 세로 키오스크` is the same flow stacked vertically; the booth
  switches layout with the screen's orientation (`portrait:`), and text and buttons scale with the
  narrower side.
- **Not done here:** the admin "지금 미디어월" side panel of A2/A3.

## D66 · 내 사진으로 참여하기: one phone photo per booth QR, reviewed like any booth photo

FOLLOW THE LIGHTS 2.0. A guest who does not want to use the booth camera can send one photo from
their own phone to the wall review queue (`docs/MOBILE_UPLOAD_ARCHITECTURE.md`).

- **The QR is a signed, stateless token** (`lib/mobile/token.ts`): `u1.<session>.<expiry>.<kiosk>.<mac>`,
  HMAC with a key derived from `KIOSK_SESSION_SECRET` under its own label (it can never be a kiosk
  cookie). 15 minutes. Issuing a QR writes nothing; the first photo creates the row. The session id
  is the photo's `session_id`, which is unique: **one photo per QR**, a retry is idempotent, a used
  QR cannot add a second photo, and a deleted one cannot bring it back.
- **The photo is our own JPEG.** The phone shrinks and re-encodes it before sending (2048 px, so
  the request stays far below Vercel's 4.5 MB limit on LTE; HEIC that the browser cannot decode
  gets a plain explanation). The server never trusts that: signature check, sharp decode with a
  pixel limit, EXIF orientation applied, every metadata block dropped (EXIF, GPS, XMP), re-encoded
  (`lib/mobile/image.ts`). No remote URL is ever fetched.
- **Same rules as the booth.** A phone photo is a `photos` row with `frame_id = 'phone-photo'`
  (no schema change, valid under the existing check), private object, same retention. It enters
  review as `PENDING` with `wall_consent` through the audited transition (`mobile_upload_consent`);
  `lib/ops/moderation.ts` and `wall_eligible_photos` decide everything after that. It has **no guest
  link** (the guest already has the photo), so `/p/…` and QR reissue never serve it.
- **Consent is explicit and is the only purpose.** The phone page cannot submit without the
  checkbox; the server refuses without `x-wall-consent: yes`. PAUSE SUBMISSIONS refuses new phone
  photos and new QRs (a phone photo is nothing but a wall submission); booth photos and QR
  downloads are untouched.
- **With a hub, the cloud is a transient inbox.** Guests' phones are on cellular data and cannot
  reach the venue LAN, so the hub asks the cloud for the QR (`/api/hub/uploads/session`). The photo
  waits in the cloud until the hub takes it (`HubInbox`: list → image → store on the hub → ack →
  the cloud deletes its copy, audited `hub_import`). Crash-safe: storing is keyed by session id;
  the cloud copy goes only after the hub has it (or has already deleted it). Moderation, exposures
  and the wall stay on the hub. This extends D40/D43: the cloud may now hold a phone photo **until
  the hub takes it**, never longer than the cloud's retention.
- **Offline.** No internet → the booth says "지금은 인터넷이 연결되지 않았어요" instead of a QR that
  cannot work. Photos already in the cloud inbox wait; nothing is shown anywhere until staff approve
  it on the hub. A hub without a cloud serves the QR itself (LAN), and the booth says the phone must
  be on the event Wi-Fi.
- **The wall hangs a phone photo as a card** (`phoneCardBox`), not in a 1:3 strip box that would
  shrink a landscape photo to a stamp. Same clip points, same rotation and timings.
- **Not decided here:** the retention period and the age rule are the church's (docs/STATUS.md);
  the phone page states only what the system enforces.

## D67 · Easy mode is a per-guest view of the same booth, with a staff default

- One machine (`lib/kiosk/machine.ts`): `mode` is state, not a fork. Easy mode skips the frame pick
  before shooting (the frame is still chosen afterwards, with the guest's own photos), counts 5
  seconds instead of 3, doubles the idle time, shows the step in words ("2단계 · 사진 확인"), and
  enlarges type, contrast and targets (CSS `.kiosk-easy`, ≥ 76 px chrome buttons). Selection count,
  consent and delivery rules are the same code.
- Guests switch at any time (welcome switch, footer button on every screen). `RESET` returns to the
  staff default, `event_settings.kiosk_default_mode` ('standard' | 'easy'), set in 관리자 → 설정 and
  audited through the one settings function (migration `20261108090000_v2_kiosk_mode.sql`). The
  heartbeat carries it to booths within a minute.
- No age question, no classification of people. Voice guidance was considered and not built:
  browser speech differs per device and the venue is loud; a staff helper is the better aid.
- Every screen also has "도움말" (QR scanning, saving, camera trouble, calling a helper), "처음으로"
  (asks first while photos would be lost), and a warning 15 seconds before an idle reset.

## D68 · The dedicated wall address is a second hostname on the same deployment

Required: the wall must have its own web address. Not required: a second codebase or database.

- **Option A (chosen): same Next.js app, host-based routing.** `WALL_HOSTS` (build time) makes `/`
  on those hosts render `/wall` and sends `/admin`, `/kiosk`, `/m/…`, `/p/…` to `PUBLIC_BASE_URL`
  (`lib/wall/host.ts`, `next.config.ts`; no middleware, so no extra function invocations). The wall
  keeps its renderer, scheduler, rotation, exposure log, show-now, pause, hours and enrollment.
  Kiosk cookies are host-only, so a display enrolled on the wall host has its own revocable session.
- **Option B (separate Vercel project / frontend):** better fault isolation for the frontend only —
  the backend, database and moderation would still be shared, so a backend outage still stops the
  wall. Costs a second project's builds and settings, duplicates env and secrets, and gives the
  on-site hub nothing (the hub has no Vercel). Not worth it at one event.
- **On the hub** the wall stays at `http://<hub>/wall`, the same renderer; nothing depends on the
  cloud. The cloud wall address only matters if the wall is ever run from Vercel.
- **Not done here (needs approval):** adding the hostname (e.g. `follow-the-lights-wall.vercel.app`)
  to the Vercel project and setting `WALL_HOSTS` is a production change (docs/DEPLOYMENT.md "8").

## D69 · Next.js security patch; the 2026-10-23 CI failures were runner allocation, not code

- `next@16.4.0` is covered by critical advisories (GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r,
  GHSA-673q-mjm6-r5xr; `npm audit`), and its build stopped with a security notice. Updated to
  16.4.5 (and `eslint-config-next`), `npm audit --omit=dev` 0. Patch release, no API change seen in
  the full test run.
- CI runs 90–96 (2026-10-23, PRs #26–#28 and their merges) ended 1–3 s after start with all three
  jobs failed, `runner_id: 0`, no steps and no downloadable log (404): no runner was ever assigned.
  That is GitHub Actions allocation (billing/spending limit or an outage), not this code. Separately,
  `main` did fail `prettier --check` on two files (`app/kiosk/enroll/page.tsx`, `docs/DEPLOYMENT.md`),
  which CI would have caught once runners worked; fixed here.

## D70 · Phone-upload inbox fixes from the Codex review of #29

Two real defects in D66, both found by the Codex review that finished just after #29 merged, both
reproduced by tests that fail on the old code:

- **The cloud inbox could lose phone photos behind booth QR copies.** `mobileInbox` read the newest
  500 kioskless `NONE`/`PENDING` rows and only then picked phone photos. The cloud keeps a QR copy of
  every booth photo (also kioskless, `NONE`) for the retention period, so after 500 of them a phone
  photo never reached the hub. The query now filters by `frame_id = 'phone-photo'` and
  `kiosk_id is null` and sorts oldest first before the limit (`PhotoListFilter.frameId`,
  `kioskless`, `oldestFirst`; all backends, contract-tested on Supabase).
- **A half-stored import was acknowledged as done.** `putMobile` writes the row, then the audited
  consent transition. If the hub stopped in between, the next pass saw the row, skipped it and let
  the cloud delete its copy: the photo stayed `NONE` without consent, invisible to review. The hub
  now finishes an existing row (`PhotoService.completeMobile`) before acknowledging; a photo
  deleted on the hub stays deleted.

## D71 · Optional pose guide; every shot counts 10 seconds

Product decision (user, 2026-11-11): "포즈 가이드를 선택하면 추천 포즈를 안내하고, 그렇지 않으면 자유
포즈로 10초 카운트다운 해서 한 컷씩 총 6컷 촬영".

- **Countdown is 10 s per shot** (`KIOSK_CONFIG.countdownSeconds`), six shots, one at a time. Easy
  mode keeps its rule "never shorter than standard" (`EASY_MIN_COUNTDOWN` floor of 5 s), so on a
  real booth both modes count 10 s. `NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS` is a test-only override
  (set to 3 in `e2e/env.ts`, inlined at build) so the E2E suite does not wait a minute per session;
  it is not in `.env.example` and must not be set on a booth.
- **The pose guide is a choice on the ready screen, not a second flow.** One filled button
  "자유 포즈로 찍기" (default) and one outlined "포즈 추천받고 찍기". `BEGIN_SHOOTING` carries
  `guide`; the state keeps `poseGuide` (false by default, cleared by RESET). The pure selector
  `currentPose` returns the pose for the shot being counted down or captured: null in free mode,
  pose i for a retake of shot i. Nothing else in the machine reads it, so shooting, selection,
  consent and upload are identical with or without the guide, in both screen modes (D67).
- **Poses are data** in `config/poses.ts` (`{ id, label }`, one per shot): 서로 마주 보기, 어깨동무,
  악수하기, twice. `tests/unit/poses.test.ts` requires the length to equal `shotsPerSession`. Text
  only: there are no pose illustrations and none were invented.
- After a camera reconnect the guest is back on the ready screen and chooses again; the shots
  already taken are kept as before.
- In easy mode the ready screen leaves out the "LIGHTS, CAMERA, ACTION!" wordmark and the empty
  shot strip (both return during the countdown): with two start buttons and the notices, the large
  type did not fit 1280 × 800 otherwise (checked with screenshots at 1280 × 800 and 1080 × 1920).
- **Not verified:** how 10 s feels at a real booth with a queue (six shots now take about 70 s),
  and whether the pose band over the preview is readable from where guests stand.

## D72 · Session video: a silent highlight reel behind the same QR (user confirmation pending)

User request (2026-11-11): "QR 코드로 사진 다운받을 때, 촬영 영상도 같이 다운받을 수 있도록". The
choices below were made to implement it and are **waiting for the user's confirmation**.

What was decided:

1. **Silent video only.** The booth never asks for a microphone (`getUserMedia({ audio: false })`,
   unchanged) and the recorder is given the camera stream as it is.
2. **A highlight reel, one file per session.** For each shot only the last
   `KIOSK_CONFIG.videoSecondsPerShot` (3) seconds of the countdown plus the capture moment are
   recorded, with one MediaRecorder that is paused between shots (`lib/kiosk/recorder.ts`). Retakes
   append while the reel is under `videoMaxSeconds` (30) and one more segment still fits under the
   size cap. Target bitrate `videoBitsPerSecond` (1 Mbit/s).
3. **Size cap `videoMaxBytes` = 3 500 000, hard.** The cloud runs on Vercel, where request bodies
   above about 4.5 MB fail. Enforced on the booth (a video over the cap is dropped whole, never
   trimmed), in `PhotoService.attachVideo`, in both upload routes (413), and by a column check.
4. **MP4 when the booth's browser can record it, else WebM.** Servers accept only those two and
   check the container's magic bytes (`lib/video/format.ts`).
5. **Strictly best-effort.** Nothing in photography, the photo upload, wall consent or QR delivery
   waits for the video or reads its result. Unsupported, failed or oversized means the session has
   no video. The guest page shows "영상 저장" only when the server really has one.
6. **Guests are told** on the ready screen: "촬영하는 모습을 짧은 영상으로도 담아요. 소리는 담지
   않아요." The line is shown only when this booth's browser can record.
7. **Phone uploads (D66) never have a video; the media wall never receives one**, nor a URL or a
   flag about it (`WallPhoto` and `wall_eligible_photos` are unchanged; tested).

How it is built:

- **Storage.** The video is an object next to the photo at a derived path
  (`<photo>.video.mp4|webm`, `videoPath` in `photo-service.ts`); the row records only
  `videoMime` / `videoBytes` (migration `20261111090000_session_video.sql`, which also lets the
  private bucket hold the two video types). Because the path is derived, every place that removes
  a photo's image removes the video too — staff delete, DELETED moderation, retention, hub
  retention, event close, `deleteForHub` — even a video whose row was never updated. `setVideo` is
  unaudited bookkeeping like the thumbnail path: it is not a decision about the photo.
- **Kiosk → server.** `POST /api/photos/video` (kiosk cookie only): raw bytes, `x-session-id`,
  after the photo exists (404 before). Idempotent per session: the first video stays. It touches
  no token, state or consent.
- **Not queued offline.** The durable IndexedDB queue stays reserved for the photo and the wall
  answer. The finished video is kept in memory (at most three sessions), sent when the photo's
  upload succeeds, tried three times (3 s and 10 s apart), then dropped: the guest sees nothing,
  the booth console gets one line, and the server logs every refusal it sees
  (`upload_video_refused`, `upload_video_too_large`, `upload_video_storage_failed`). A reload or a
  long outage loses the video, never the photo.
- **Hub + cloud.** `CloudCopy.video` (PENDING → SYNCED | DROPPED). `CloudSync.trackVideo` sends it
  with `putVideo` → `POST /api/hub/photos/video` (Bearer `HUB_SYNC_SECRET`, hub copies only, 410
  once the copy is deleted) under the same per-photo lock, only after the photo copy is SYNCED. It
  never calls `put` or `reissue`, so the guest token is never reissued and a scanned QR keeps
  working. The QR never waits for it. Retries use the same backoff; after 8 tries or a final
  refusal the video is DROPPED.
- **Guest.** `GET`/`HEAD /p/[token]/video`: same uniform 404 as the image for unknown, expired
  and deleted links and for photos without a video; `Content-Type`, `Content-Length`,
  `Accept-Ranges`, single byte ranges (206/416), and the image route's `private, no-store`.
  The page adds a secondary "영상 저장" (`save-video.tsx`, same share-or-download approach as the
  photo); the photo stays the one primary action.
- **USB backup includes videos.** The backup mirrors the hub's `objects/` folder, so videos are
  copied with the photos and removed from the stick when the hub deletes them. Up to 3.5 MB more
  per session on the laptop and the stick.

Choices the request left open (also for the user to confirm):

- The video is the raw camera picture: **not mirrored** (the photo is) and not cropped to 4:3.
  Mirroring would need a second canvas pipeline running during the shoot.
- Recording ends when the guest confirms the shots ("이대로 좋아요"); a session abandoned before
  that has no video. A camera reconnect mid-session starts the reel over.
- Staff pages do not show or play the video; moderation is about the photo. Deleting the photo
  deletes the video.
- The guest page is rendered once: if the phone opens the link before the video has arrived
  (normally a second or two after the photo), the button appears on a reload.
- Storage statistics (`storedBytes`) still count photos only.

Known limit: the video route sets `Content-Length` (unit-tested at the handler), but Next.js
16.4.5's own Node server (`next start`, i.e. the hub) removes that header from every route
response and sends it chunked (`FORBIDDEN_HEADERS` in `next/dist/server/send-response.js`; the
photo route has always been served that way). A 206 still carries the total size in
`Content-Range`. No workaround was forced; what Vercel puts on the wire was not checked.

Not verified: playback and saving on real phones — in particular **iPhone with a WebM file**
(only produced when the booth's browser cannot record MP4), and saving a recorded MP4 to the
iPhone Photos app from the share sheet. Real booth cameras at 1 Mbit/s (picture quality, actual
file sizes). The migration on a real Supabase project.

## D73 · The brand is STUDIO SHALOM; the flow, the rules and the wall scene do not change

User decision (2026-11-11): the service is renamed from FOLLOW THE LIGHTS to **STUDIO SHALOM**
(평화의 벽). The event is still "Christmas Village 2026". The theme verse reference is "MT 5:9";
the verse text is not decided, so it is written nowhere.

What changed:

1. **Name and lockup** wherever a person sees them: booth, `/p/[token]`, `/m/[token]`, admin
   header and login, kiosk enrollment, page titles, download file names
   (`studio-shalom-DATE.jpg|mp4|webm`), the staff login email, the hub console and the `ops/`
   wrappers, the USB backup README. The lockup is four stacked, centred parts: `STUDIO` /
   `SHALOM` / a short thin divider / `평화의 벽`. On screen it is real text
   (`components/brand.tsx`); screen headers too small for it use the name on one line
   (`BrandWordmark`).
2. **Tokens** (`app/globals.css`): `backdrop #DDBDA1`, `ink #2B1A10`, `button #412D1B`,
   `button-text` = `paper #F6EEE4`, `accent #7A440E`. The night tokens (`ink` as a background,
   `night`, `dusk`, `amber`, `ember`, `cream`, `mist`, `navy`, `gold`, `warm`, `glow`, `ink-400`)
   are gone, not aliased. Flat paper: no star field, no gradients, no glow shadows. One filled
   button per view, pill buttons, 24 px cards, 8 px small controls. Muted text is `ink/75`
   (5.26:1 on backdrop). `accent` is 4.46:1 on backdrop, so it is used for text only at ≥ 24 px.
3. **Staff status colours** are functional, not brand: `approve #1B5233`, `danger #8F1D14`,
   `alert #7C3500`. Each is ≥ 4.5:1 as text on backdrop and on paper, and under `button-text`.
4. **Fonts**, all OFL and bundled so the hub works offline: Cormorant Garamond 500/600 (`STUDIO`,
   `SHALOM`) and Nanum Myeongjo 400 (`평화의 벽`), only in the lockup. UI text stays Noto Sans KR
   (Pretendard is undecided). Countdown numerals stay in the sans: Cormorant's old-style "10" reads
   as "IO".
5. **Frames.** Layout, slots, ids and the other art are unchanged. Only the lockup art changed:
   `public/frames/{navy,wood,cream}-lockup.svg` are now STUDIO SHALOM lockups whose glyphs are
   outlined paths taken from the bundled font files (a canvas has no web fonts), in each frame's
   earlier lockup colours. The lockup box in each frame is `lockupBox(y, height)`
   (`config/frames/shared.ts`).
6. **The legible-wordmark rule changed numbers.** It was "at least 55 % of the output width" for a
   one-line wordmark (418 × 69, letters about 30 px tall). The stacked lockup is 422 × 156.13: at
   55 % width it would be 122 px tall, and three frames (wood, clothesline, cream) have about
   90–100 px between the art above and below it. The rule is now width ≥ 38 % **and** height ≥ 80 px
   (SHALOM capitals about 32 px, so the main word is not smaller than before), the SVG's own
   proportions, centred, outlined paths only, below every photo, contrast ≥ 4.5:1. `평화의 벽` is
   about 13 px tall at 1× (26 px in the saved 2× file) in the three tight frames.
7. **The "LIGHTS, CAMERA, ACTION!" title art** on the ready screen was removed (an old-brand pun);
   nothing replaces it.
8. **The media wall keeps its clothesline night scene**: layout, rotation and animations are
   untouched. Its colours moved to a palette scoped to the wall (`.wall-stage`, `--wall-*`, the old
   values). Only the wordmark changed: the text in the holding screen and on the phone-photo card,
   and the wordmark painted into `public/wall/background-v3.jpg` (the old one was filled in from
   the plain strip either side of it and the lockup drawn in the same gold).

What did not change, on purpose:

- **Internal identifiers** keep the old name: `FTL_ROLE` and the other `FTL_*` variables, SQL
  `ftl_*` functions, the `ftl_staff` cookie, migration files, IndexedDB `follow-the-lights` (queued
  uploads live there), the wall browser profile folders in `ops/start-wall.*`, `x-client-info`,
  the Supabase `project_id`, the package name, the repository and the
  `follow-the-lights-wall.vercel.app` hostname. Renaming any of them breaks deployed hubs or loses
  queued uploads.
- **Flow and rules.** The Figma kiosk flow for STUDIO SHALOM has a name input, a checkbox consent
  and a grid wall. None of them was built: no personal data is collected, the wall question keeps
  two equal answers, and the wall is the clothesline scene (`design/README.md`).
- **Copy.** Korean UI strings were kept unless they contained the brand name. The welcome title
  "별빛을 따라 오셨나요?" and the cream frame's "별빛을 따라 오신 걸 환영해요" still speak the old
  theme; replacing them needs new copy from the user.
- Historical records (earlier STATUS sections, decisions, reports, `design/previews/`) keep the
  old name.

Not verified: any real device (booth touch screen, phones, the LED wall); colour and legibility in
the venue's light; the lockup's relative sizes against the Figma file (the spec gave the fonts and
letter-spacing, the size ratios were chosen here); the staff login email on a real Supabase
project.

## D74 · No guest help on the booth; the wall take-down line moves to the phone page

User decision (2026-11-11): staff are at the booth for the whole event, so the booth's guest help
is removed.

- Removed: the "도움말" button on the welcome screen and in the footer ("도움이 필요해요" in easy
  mode), the help dialog (`GuestHelp`), its state and its E2E check.
- Kept: staff help mode (D59: corner hold + name + PIN). The name is similar but it is the staff
  recovery tool. "처음으로" and "쉬운 화면" stay.
- The dialog told guests how to have a photo taken off the wall. That is the way to withdraw
  consent, so it must stay somewhere: `/p/[token]` now ends with "미디어월에 걸린 사진을 내리고
  싶으면 부스 직원에게 말씀해 주세요." The cloud copy has no wall consent (D40), so the line shows
  for every guest, whatever they answered.
- The "how to scan the QR" and "how to save the photo" tips are gone from the screen; staff
  explain them.

Not verified: whether guests get stuck on site without the on-screen tips.

## D75 · Old-theme copy and emoji icons go

User decision (2026-11-11): replace what still spoke the star-night theme, wording left to us.

- Welcome title "별빛을 따라 오셨나요?" → "사진관에 오신 걸 환영해요" (the brand is an analogue photo
  studio; the line under it already says what the booth does).
- Cream frame caption "별빛을 따라 오신 걸 환영해요" → "PEACEMAKERS · MT 5:9", the line the user
  specified for the bottom of the STUDIO SHALOM frame. The verse text itself is still undecided
  and is written nowhere.
- Frame picker labels drop "별빛": "포스트카드 · 2컷", "다섯 장 · 5컷". Frame ids are unchanged.
- The two welcome choices use line icons (`LineIcon` in `components/kiosk/ui.tsx`, the same
  drawings as the Figma icons) instead of emoji; they take the button's text colour.

## D76 · The user's own wording replaces D75's two lines

User decision (2026-11-11). D75's wording was ours; the user set the final strings:

- Welcome title: "크리스마스의 추억을 함께 남겨요".
- Cream frame caption: "Matthew 5:9".

Do not reword guest-facing copy without the user's own text.

## D77 · A star in the O of SHALOM; a STUDIO SHALOM 2×2 frame

User decisions (2026-11-12): the O of SHALOM holds a four-pointed star, as the O of FOLLOW THE
LIGHTS once did; and a STUDIO SHALOM 2×2 frame is added next to the existing frames (all kept).

- **Star.** The same star (a concave four-pointed sparkle, 0.63 : 1) in every lockup, in the
  letters' own colour. Frames: an extra `<path id="o-star">` in `public/frames/*-lockup.svg`,
  centred in the O's counter (found from the outlined glyph: 297.6, 65.5 in the 422 × 156.13
  lockup) and 36 tall (60 % of the counter). Screen: `components/brand.tsx` draws it over the real
  letter (`.brand-o`, `.brand-o-star` in `app/globals.css`), so the text is still "SHALOM" for
  copy, search and assistive tech. `tests/unit/frames.test.ts` checks every frame lockup has the
  star in the letters' colour; `e2e/shalom-booth.spec.ts` checks the star sits inside the O.
  Not changed: the wordmark painted into the media wall picture (`public/wall/background-v3.jpg`).
- **2×2 frame** (`config/frames/shalom-grid.ts`, id `shalom-grid`): 600 × 750 (4:5, saved
  1200 × 1500), backdrop `#DDBDA1`, four 4:3 photos (252 × 189) on 6 px paper mats, the ink lockup
  (`public/frames/shalom-lockup.svg`, 104 tall) below the photos, then "Christmas Village 2026 ·
  {date}" and "MT 5:9" in ink. It meets every frame rule; the size rule now reads "strips 600 ×
  1800, the 2×2 600 × 750". First in the picker; the preselected frame stays the navy strip
  (`DEFAULT_FRAME_ID`), so nothing else changes for a guest who does not pick it.
- The Figma "10 네컷 프레임" (1200 × 1800, lockup at the top, near-square photos) was not copied:
  the photos must be 4:3 (preview = result) and the lockup must sit below the photos (never over a
  face). The 2×2 keeps the Figma idea (four photos in a grid, paper mats, backdrop colour, lockup,
  MT 5:9) within those rules.
- **Wall.** A frame that is not a 1:3 strip hangs as a box at the phone card's width (340 px),
  centred on the same clip and never taller than a strip (`framedPhotoBox`, `lib/wall/layout.ts`),
  instead of shrinking inside the strip box. Strips are unchanged.

## D78 · Korean / English booth, and a "이전" (back) step

User decisions (2026-11-12): the SS 01 kiosk flow in Figma goes into the code **without removing
any existing feature** (phone participation, easy mode, staff help, single-shot retake, frame
pick); **no name input** (no personal data, unchanged); the booth gets **Korean and English**.

Most of the Figma SS 01 UX was already in the code (progress, "처음으로" with a confirmation, two
equal wall answers, the selection count, the reset notice on the QR screen). What was missing:

- **Language** is a view, like the screen mode (D67): `lang` in `lib/kiosk/machine.ts`
  (`SET_LANG`, any time; `RESET` returns to Korean, so every guest starts in Korean). The welcome
  screen has a `한국어 · English` switch next to the screen-mode switch. Every guest-facing string
  is in `lib/kiosk/copy.ts`, Korean exactly as before (D76: the user's wording) and English
  written for it; frame and pose names carry `labelEn`. `<html lang>` follows the choice. Staff
  text (help mode, status badges, admin) stays Korean. A unit test checks the English copy has
  every key the Korean has and no Hangul (two deliberate exceptions: the picker's own label and the
  phone page's Korean button name, quoted with its meaning).
- **Back** ("이전", top left of the screen header) is offered only where nothing the guest made is
  lost (`canGoBack`): frame pick → welcome; the camera before the first shot → frame pick (easy
  mode: welcome, it skipped the pick); photo selection → frame. Not during shooting, not after a
  shot exists (a reconnect keeps shots), not from the frame screen after shooting (the session
  video is already closed), never once the frame is final (the upload has started).

Not done: the phone pages (`/p/[token]`, `/m/[token]`) stay Korean only; an English guest scanning
the QR sees Korean there. The English copy was written here, not by the user: it needs the user's
check, like any guest copy.

## D79 · The letter sheet and the wax seal on the booth

User decisions (2026-11-12): the wax seal (a red wax disc with the four-point star, the image the
user made) replaces the old "MT" stamp idea, toned to a matte red so it is not brown and does not
look pasted on; the booth screens look like **letter paper** so the seal belongs to them ("A로
가자": option A of the Figma comparison).

- Every booth screen puts its content on **one sheet of paper** on the backdrop:
  `LetterSheet` in `components/kiosk/ui.tsx` (`.letter-sheet`: `paper`, radius 8, a 1 px `ink`/10
  edge). `BoothScreen` uses it, and so does the welcome screen. The header (back, wordmark,
  progress) and the footer buttons stay on the backdrop, outside the sheet. Paper boxes on the
  sheet (the QR boxes) get a 1 px `ink`/15 edge so paper on paper still reads.
- The **seal is pressed only twice**: on the first screen (the attract screen since D80) and on the QR screen once the QR is real
  (`delivery-ready`). A seal on every screen stops meaning anything; first and last screen are the
  letter's opening and its closing. Not on the "QR 준비 중" or offline screens.
- The seal is **decoration**: `public/brand/wax-seal.webp` (480 px, 27 KB; the Figma filters
  contrast −25, saturation −20, highlights −65, shadows +20 baked in), `alt=""`, `aria-hidden`,
  `pointer-events: none`, at the sheet's bottom-right corner, never over a button and never
  making the page scroll. It is an image, not a brand colour or a gradient in the UI, so the
  token rule stays as it is. It carries no text and no verse.
- iPad portrait (820 × 1180): the welcome cards are a little shorter and the QR box a little
  tighter so the welcome and QR screens fit without scrolling; the "다 받았어요" button is no longer
  full width in portrait, which keeps the sealed corner clear.
- Figma: the KIOSK page has the same sheet on every screen, the seal on 1a, 1b, 1c and 8a.

Not done (fixed later in D81b): the review screen (4) still scrolls on a portrait tablet (it did before; its two-column
photos are tall). The media wall does not use the seal; frames did not either until the letter
frame (D82).

## D80 · "화면을 눌러 시작" comes back as the first screen

User request (2026-11-12): the intro screen with "화면을 눌러 시작" is needed. It was the first
screen until the 2.0 release (#29), which replaced it with the two-choice welcome.

- New phase `attract` in `lib/kiosk/machine.ts`, the initial state and where `RESET` returns.
  Only `OPEN` (a touch anywhere on the screen, or its button) leaves it, to `welcome`; `START` and
  `START_MOBILE` still need `welcome`. A new staff default mode applies at once on `attract` and
  `welcome`. "이전" from the frame pick still goes to `welcome`, not further.
- The screen: one letter sheet with the lockup, "Christmas Village 2026", the one filled button
  "화면을 눌러 시작" (the user's wording) and, small, "Tap the screen to start": nobody has chosen a
  language yet, so it shows both. No progress, no back, no footer.
- The seal moves from the welcome choices to this screen: the guest opens the sealed letter, and
  the QR screen closes it (D79 keeps two seals).
- The idle reset now also runs on the welcome choices: a guest who chose English or the easy view
  and walked away leaves the booth on the attract screen in Korean and the staff default.
- E2E: `openWelcome` in `e2e/helpers.ts` taps through the attract screen; after a reset the specs
  expect `screen-attract`.
- Figma: KIOSK `0 · 화면을 눌러 시작 (인트로 · 봉인)` in the first section, seals removed from 1a–1c.

## D81 · The letter sheet becomes a faded diary page

User request (2026-11-13): make the kiosk screens feel more like a faded diary ("빛 바랜 다이어리").
The brand rules stay: no new colour, no gradient, no glow, one filled button per view.

- `.letter-sheet` (`app/globals.css`): the paper is `paper` with 18 % `backdrop` mixed in
  (`--sheet-faded`), a fine ink grain (`--grain-ink`, an SVG `feTurbulence` data URI, ink at a few
  percent) and faint ruled lines (`--ruled-lines`, `accent` at 12 %, one line every
  `max(40px, 5.6vh)`). Its edge is `accent`/20 instead of `ink`/10. Textures are SVG images, not CSS
  gradients.
- The booth's backdrop gets the same grain (`.kiosk-desk` on the kiosk `<main>`), so the sheet
  sits on a desk instead of a flat colour. Only the booth: admin, phone pages and the wall are
  unchanged.
- Easy mode keeps the faded paper and grain but drops the ruled lines: nothing behind the big type.
- Contrast on the faded sheet: ink 13.5:1, ink/75 6.54:1, accent 6.38:1. Paper boxes on the sheet
  (welcome card, QR box) keep the plain `paper`, so they read as cards laid on the page.
- Figma (ZbeBrS0o5012SNFrGZNyIU, KIOSK page): every `편지지` frame (27) has the same layers:
  `color/paper`, `color/backdrop` at 18 %, a ruled-line image tile (none on 1b, the easy screen),
  a monotone noise effect, and a `color/accent` edge at 20 %.

Not verified: how the grain and lines look on the real booth screen and under the venue's light.

### D81b · Torn edge, tape and photo corners (2026-11-13)

User verdict on the first pass: still "밤티" (a filter over an app, not a diary). User choice: mix
option A (things taped and mounted) with option C (an aged, torn edge).

- The sheet's paper moves to `.letter-sheet::before`, cut by a **torn edge** (SVG mask tiles
  `--torn-*`, 520 px long so the repeat does not show). `::after` tones a **rough rim** just inside
  it with `backdrop` at 30 % (`--rim-*`), the way old paper yellows from the edge. The sheet itself
  is not clipped, so the seal still hangs over its corner. No border.
- **Masking tape** (`Tape`, `.tape`): two strips on the sheet's top corners and one on each QR box
  (delivery and phone upload). `accent` at 20 % with the ink grain, torn ends (`clip-path`). It
  sits at most 4 px above the sheet, never over a button, `aria-hidden`, no pointer events.
- **Photo corners** (`PhotoCorners`, `.photo-corner-*`): album corners in `ink` at 85 % on the
  camera preview and on each photo of the review screen. Those prints are now 4 px corners
  (`rounded-sm`), not cards. No pointer events, so a touch on a photo still works.
- The **review screen** (4) no longer scrolls: six prints in one row on a landscape booth, 3 × 2
  on a portrait tablet (`review-grid`). Before, 4 × 2 (landscape) and 2 × 3 (portrait) pushed
  "이대로 좋아요" below the screen at 1280 × 800 and 820 × 1180. E2E checks 1280 × 800,
  1920 × 1080 and 820 × 1180: every print and the button fully on screen, no scroll.
- Not on: buttons (the welcome choices stay as they are), easy mode differences (tape and corners
  show in both modes), frames, phone pages, the wall.
- Figma KIOSK: every `편지지` holds a `종이 (찢긴 가장자리)` vector (paper, backdrop 18 %, ruled-line
  tile except 1b, 10 px inside rim stroke backdrop 30 %, noise) and two `테이프` vectors; the QR
  boxes on 8a and M1 have `테이프 · 가운데`; the camera previews (3b–3d) and the six photos of 4 have
  `사진 모서리` vectors.

## D82 · The STUDIO SHALOM letter set: frames for 1 to 6 photos

User request (2026-11-13): keep improving the frames already made in the STUDIO SHALOM version, and
add trendy photo-booth templates that are not only four-cut: one, two, three and six photos too.

- **One idea for the set: things you put in an envelope.** The booth is already a letter (D79), so
  each new frame is a paper object of its own size, not the same strip with fewer photos. Picker
  order: the 2×2 (D77) first, then the set by number of photos, then Template A–D. The preselected
  frame stays the navy strip.

  | id                 | 이름       | 사진 | 크기 (저장은 2배) | 모양                                                   |
  | ------------------ | ---------- | ---- | ----------------- | ------------------------------------------------------ |
  | `shalom-single`    | 한 장      | 1    | 600 × 750         | 종이 위 사진 한 장, 아래 가는 선과 행사·날짜 한 줄     |
  | `shalom-postcard`  | 엽서       | 2    | 900 × 600 (가로)  | 사진 두 장 나란히, 아래 POST CARD 글과 별 우표(MT 5:9) |
  | `shalom-film`      | 필름       | 3    | 600 × 1500        | 짙은 갈색 필름, 양옆 구멍, 사진마다 01·02·03 번호      |
  | `shalom-letter`    | 편지       | 4    | 600 × 1800        | 가는 테두리 편지지에 네 장, 로고 옆 밀랍 봉인          |
  | `shalom-highlight` | 하이라이트 | 5    | 600 × 1050        | 큰 사진 한 장 + 작은 사진 넷, 종이 매트                |
  | `shalom-stamps`    | 우표       | 6    | 600 × 960         | 톱니 우표 여섯 장(No.01–06), 2열 3줄                   |

- **Rules kept.** Every slot is 4:3 (preview = result), square-cornered; the lockup is below the last
  photo, ≥ 38 % of the width and ≥ 80 px tall, centred; colours are only the five brand tokens
  (`backdrop`, `paper`, `ink`, `button`, `accent`), no gradient, no glow. A unit test checks the
  set uses only those colours and that no image decoration (seal, star) covers a photo.
- **New assets.** `public/frames/shalom-lockup-paper.svg` (the same lockup in `paper`, divider in
  `backdrop`, for the dark film), `public/frames/shalom-star-ink.svg` (the O-star alone, for the
  postcard stamp), `public/frames/wax-seal.webp` (a copy of `public/brand/wax-seal.webp`: frame
  assets all live under `/frames/`).
- **The seal on a frame.** D79 kept the seal off frames. The letter frame now carries it, at the
  foot beside the lockup, because a letter is where a seal belongs and the user's own Figma frame
  ("10 네컷 프레임 · 구절 있음") already presses one there. The booth screens still show it only on
  the attract and QR screens; the seal is decoration in the image, not a colour token.
- **Type.** Canvas text is Noto Sans KR only, so the set keeps to three caption styles: 600/13
  labels, 600/15 headings, 500/15 body (the 2×2 captions moved to the same 600/13). Figma has no
  Noto Sans KR SemiBold; Figma "Bold" stands for code 600.
- **Retired.** The plain strips `two-stars`, `three-moments`, `five-lights`, `six-lights` (old
  navy/gold colours, photos floating in a 600 × 1800 strip) are gone from the picker. Their ids
  stay in `RETIRED_FRAME_IDS`, so an upload waiting in a kiosk queue is still accepted.
- **Wall.** Nothing new: every non-strip frame hangs as a box at the phone-card width
  (`framedPhotoBox`, D77). The landscape postcard hangs 340 × 227.
- Figma: SS 02 page, "편지 세트" row (`20`–`25`), at the saved 2× size, editable layers.

User decision (2026-11-13): the seal on the letter frame stays, and the six names are final.

Not verified: how the 13 px captions (26 px in the saved file) read on a real phone, and the set on
the real media wall screen.

## D83 · Landscape frames: ticket, card, Advent calendar

User request (2026-11-13): pretty landscape frames too ("가로 프레임도 이쁜것도").

| id              | 이름        | 사진 | 크기 (저장은 2배) | 모양                                                                             |
| --------------- | ----------- | ---- | ----------------- | -------------------------------------------------------------------------------- |
| `shalom-ticket` | 티켓        | 3    | 960 × 470         | 둥근 종이 티켓, 사진 셋 한 줄, 양옆 홈과 점선 절취선, 아래 ADMIT ONE·날짜        |
| `shalom-card`   | 카드        | 4    | 1000 × 720        | 펼친 크리스마스 카드: 가운데 2×2, 양옆 여백에 행사명·별·날짜·MT 5:9, 가는 테두리 |
| `shalom-advent` | 대림절 달력 | 6    | 900 × 700         | 대림절 달력 문 여섯 개(DEC 01·06·12·18·24·25), 25일 문만 짙은 색                 |

- Same rules as D82: 4:3 slots, the lockup below the last photo, centred, ≥ 38 % of the width (so a
  landscape frame needs a wide foot: 136–142 px tall at 1×), brand tokens only (the Christmas door
  uses `button`), captions in the D82 type styles. The side margins carry the small captions so the
  foot holds only the lockup.
- Picker: after the letter set, before Template A–D. Wall: `framedPhotoBox` hangs them at the
  phone-card width (340 px wide).
- New frame words: "ADMIT ONE", "No. {date}", "DEC 01"–"DEC 25", "MERRY CHRISTMAS". Written here, not
  by the user: they need the user's check, like any guest copy.
- Figma: not drawn yet (SS 02 has the D82 row only).

## D84 · /admin opens with the kiosk enrollment password; the session is its own

User decision (2026-11-13, non-negotiable): the administrator password is the **same** value as
booth enrollment, `KIOSK_ENROLL_SECRET`. No `ADMIN_PASSWORD`, no email step, no second PIN in the
main flow: open `/admin`, type the password, press 관리자 화면 열기.

- **One credential, separate sessions.** `POST /api/admin/auth/password` issues an HttpOnly,
  SameSite=Lax cookie `ftl_admin` (`lib/staff-auth/shared.ts`): `a1.<issuedAt>.<expiresAt>.<hmac>`,
  12 hours (`ADMIN_SESSION_HOURS`). Its MAC key is derived from `KIOSK_SESSION_SECRET` with an
  admin-only label **and the password itself**, so (a) a kiosk cookie or a hub PIN cookie can never
  verify as an administrator, and the other way round, and (b) changing either secret ends every
  administrator session at once. Kiosk routes never read `ftl_admin`; staff routes never read
  `ftl_kiosk`. Enrolling a booth sets no administrator cookie; logging in enrolls nothing.
- **Who it acts as.** Everyone who knows the password is the same fixed identity,
  `SHARED_OPERATOR` (id `5ca1ab1e-0000-4000-8000-000000000001`, shown as 공용 관리자). It is not a
  row in the staff list (nothing to deactivate, no PIN, nobody to impersonate); the audit log
  stores that id for every action taken through a shared session.
- **Checks.** Constant-time comparison (`safeEqual`), same-origin + JSON only, the password is
  never logged, echoed or stored in the browser (the field is cleared after every attempt). Limits
  per client address: 30 attempts and 8 wrong passwords per 15 minutes. There is deliberately no
  global lock: it would let anyone on the internet lock the operators out by guessing.
- **A short password is refused for /admin** (< 12 characters, `sharedAdminProblem`): it still
  enrolls booths, the login page says why, and the personal login is all that is offered.
- **The personal staff login stays as a fallback**, one link from the login page
  (`/admin/login?staff=1`): email code on the cloud, name + PIN on the hub. It is still needed for
  booth help mode on the hub (D59 checks a staff PIN) and it is the only way in when no usable
  password is configured.
- **Accepted trade-offs (the user's).** Anyone who can enroll a booth can now moderate, delete and
  change settings. The audit log says _that_ the shared operator did something, not _which
  person_. Sign-out clears the cookie in that browser; a copied cookie stays valid until it
  expires (≤ 12 h) or a secret is rotated, because the session is stateless. Rotate
  `KIOSK_ENROLL_SECRET` if the password leaks: that also means re-typing it for new booth
  enrollments, while already-enrolled booths keep working (their cookie does not depend on it).

## D85 · The media wall has themes; a theme is data

The wall was still the FOLLOW THE LIGHTS night picture with a new wordmark. The current Figma
(`SS 03 · 미디어월 시안 — The Wall of Peace`) holds eight STUDIO SHALOM backgrounds and an empty
"최종 확인용 캔버스": nothing had been chosen, and nothing was in code.

- **A theme is one entry in `config/wall-themes.ts`** (`WallTheme`, `lib/wall/themes.ts`): id,
  staff name, Figma source frame, a bundled 3840 × 1080 picture and 640 × 180 preview, a fallback
  colour, the hang line (`y = y0 − curve·(x − midX)²`), the strip box, the slots, how a photo is
  held (a drawn wooden peg, or pegs already in the picture), an optional drawn twine, the widest
  box for non-strip photos, where the wordmark goes, low-spec slots. The renderer
  (`components/wall`) never knows a theme by name.
- **Nine themes.** Eight from Figma — S01 눈 덮인 예배당, S02 성탄의 별, S03 평화의 벽, S04
  베들레헴 (3:1, cut to 32:9 by `scripts/wall-backgrounds.mjs`), C01–C04 해안 창가 (32:9) — plus
  the old night scene as `night-window`, marked `legacy`: selectable, never the default.
- **Slots are measured in each picture** and keep clear of what the picture is about (the chapel,
  Bethlehem and the manger, the setting sun, the cross) and of the lantern and candles. S02/S04
  have eight pegs painted in; photos hang from every other peg so a wide photo never touches its
  neighbour. C03's photos hang from its painted string of lights. C01/C02/C04 have nothing to hang
  from, so the app draws a twine across the window.
- **Every format keeps its proportions**: 1:3 strips in the strip box; 2×2, single, landscape
  ticket/card/calendar in a box up to the theme's `wideMax` (`framedPhotoBox`); phone photos on
  their card. `object-fit: contain` everywhere; nothing is stretched or cropped.
  `tests/unit/wall-themes.test.ts` checks every theme × every frame: inside the picture, ≥ 30 px
  between neighbours, the wordmark never behind a photo.
- **The wordmark is real text** (`STUDIO SHALOM | 평화의 벽`) placed per theme where no photo
  reaches; on a picture with no calm spot it sits on a small paper tag.
- **Staff choose in /admin → 설정 → 미디어월 배경**: preview cards, the active theme, optional
  rotation between ticked themes every 5–120 minutes, one-tap reset. Stored as
  `event_settings.wall_look` (jsonb), one audited settings call. The feed names the theme, so every
  wall follows within one poll (≤ 5 s) with a cross-fade, and rotation is a function of the clock
  alone (`activeThemeId`): all displays agree, a reload changes nothing. Changing the look never
  touches photos, moderation or the booth.
- **Default: `peace-wall` (S03). Chosen by Claude, not by the user**: the plain plaster wall is
  named after the brand line 평화의 벽 and is the calmest backdrop for photos. The user confirms or
  changes it in 설정.
- **No ambient animation.** A still picture is the design; photos swing in and out as before,
  fades only in low-spec mode (`?lite=1`) and with `prefers-reduced-motion`.
- **Known limit: the originals are about 2048 px wide.** On a 3840-px LED they are enlarged 1.9×
  (Lanczos resampling, no added detail). A sharper original replaces the file without touching the
  numbers if the composition is the same.

## D86 · The wall address needs no enrollment; what it may show is decided per photo

User requirement: `https://studio-shalom-wall.vercel.app` opens the wall at once: no code, no
device password, no enrollment form. But an address on the internet is not the screen at the
venue, and "이 사진을 미디어월에 띄워도 될까요?" was only ever asked about that screen.

- **The page is open; the feed decides.** `/wall` renders for anyone. `/api/wall/feed` and the
  image proxy classify each request (`lib/wall/audience.ts`): a valid kiosk cookie is an enrolled
  venue **display** and gets what it always got; anything else (no cookie, forged, expired,
  revoked) is the **public** audience. Being public is not an error and grants nothing else.
- **Public audience = public-scope consent only.** `photos.wall_public` (default false) is set
  only by the consent transition, only together with a YES, and only when (a) the booth or phone
  page showed the public-wall line and said so (`scope: "public"` / `x-wall-scope: public`) and
  (b) staff have the public wall switched on at that moment. A NO always clears it. Staff actions
  never touch it. The anonymous feed reads `wall_public_photos` (the wall rule AND `wall_public`);
  the image route re-checks the row on every request.
- **Default off, and old photos stay venue-only.** `event_settings.wall_public` starts false: an
  anonymous viewer then gets the scene and no photo ids at all. Every photo taken before this
  change, or while the switch was off, has `wall_public = false` for good: nothing can widen a
  consent after the fact. They still appear on an enrolled display.
- **The switch is a staff decision with a confirmation** (/admin → 설정 → 공개 미디어월). Turning
  it on makes the booth add one line to the consent screen, "미디어월은 행사장 화면과 온라인
  주소에서 함께 보여요." (written by Claude, pending the user's wording, D76), within one
  heartbeat (≤ 1 min); the phone page shows the same line. Turning it off stops sending photos to
  anonymous viewers at once and keeps the consent records.
- **Anonymous viewers only read.** `/api/wall/shown` (exposure log, show-now) and the heartbeat
  still need a kiosk session (401 otherwise); the public feed is always newest-first and ignores
  `?on=`, so nothing an anonymous browser sends can change the rotation, exposure counts or
  anything staff see. An enrolled display keeps the fair rotation (D46).
- **Everything else is unchanged for both audiences**: moderation, PAUSE WALL, the holding screen
  and opening hours apply on the server; hides and deletes leave within one poll; ids and frame
  ids only, `no-store`, no storage paths, tokens or kiosk ids; rate limits per display / per
  address.
- **Hub mode.** Consent and moderation never go to the cloud (D40), so with a hub the cloud wall
  address shows the scene with no photos; the venue wall is the hub's `/wall`. Phone photos the
  hub imports from the cloud inbox are venue scope.
- **Cost to know about.** Each open wall polls every 5 s and is not cached (a hide must leave in
  one poll). Many people keeping the public address open means that many function calls a minute.
- This replaces "the wall display is an enrolled device" (D36) for _viewing_. Enrollment remains,
  for the screen that should show every approved photo and report what it showed.

## D87 · STUDIO SHALOM addresses: add the new names, keep the old ones working

Wanted: `https://studio-shalom.vercel.app` (booth, staff, guest links) and
`https://studio-shalom-wall.vercel.app` (wall), on the same Vercel project, database and code.

- **Checked 2026-11-13:** both new names answer `404 DEPLOYMENT_NOT_FOUND` (not attached to any
  deployment, so they are free to claim); `follow-the-lights.vercel.app` and
  `follow-the-lights-wall.vercel.app` serve the current production.
- **Not done here: attaching the names and changing the variables.** The Vercel connection of this
  session cannot see the `follow-the-lights` project and the stored API token is rejected, so the
  steps are written out in `docs/DEPLOYMENT.md` "10".
- **No code change is needed to serve two booth names or two wall names.** `WALL_HOSTS` is already
  a list; CSRF checks accept the request's own host; guest tokens, phone-upload tokens and session
  cookies do not contain a host. So the migration is additive:
  `PUBLIC_BASE_URL=https://studio-shalom.vercel.app` (new QR codes),
  `WALL_HOSTS=studio-shalom-wall.vercel.app,follow-the-lights-wall.vercel.app`.
- **The old names are kept, not redirected.** A QR printed on a phone screen yesterday points at
  the old booth name and must keep opening for its 72 hours; a booth enrolled on the old name has
  a host-only cookie and would have to be enrolled again on the new one. Redirecting the old booth
  name would break both, for a cosmetic gain. Old _wall_ name: its `/admin`, `/kiosk`, `/p/…`,
  `/m/…` go to the new booth name as before (D68), and `/` stays the wall.
- **No loops:** a wall host never redirects to itself (`wallHostRedirects` skips the booth host),
  and the booth host has no redirects at all (`tests/unit/wall-host.test.ts`).
- **Internal names stay** (`FTL_*`, `ftl_*`, IndexedDB `follow-the-lights`, the Vercel project
  name, the Supabase `project_id`): renaming them loses queued uploads or breaks deployed hubs.

## D88 · The booth has one layout system, sized from the booth's own box

The owner ran the booth on an iPad Air 4 (Safari, 820 × 1180 and 1180 × 820) and found it broken:
proportions off, buttons of several sizes, cramped or empty screens. A baseline capture of 11
viewports × 29 screens showed why: screens were sized from `vh`/`vw` with fixed minimums, so most
of them were taller than a tablet and the page scrolled (frame choice by up to 265 px, with the
footer off screen and the main button drawn over the cards), and five different button formulas
were in use. Two of the defects were functional: the invisible staff-help corner lay on top of
"이전" on portrait tablets, and a scrolled screen carried its scroll position into the next one.

- **One box, one scroll area.** `main.kiosk-root` is exactly the viewport (`100dvh`, `100vh`
  fallback), never scrolls, and is a size container. `.kiosk-scroll` inside it is the only scroll
  area; every new screen starts at its top.
- **Two units, a handful of tokens.** `--bw` / `--bh` are 1 % of the booth's width and height
  (container units, viewport units as fallback). Space (`--booth-pad`, `--sheet-pad-*`,
  `--gap-*`), type (`--fs-title`, `--fs-lead`, `--fs-caption`), controls (`--btn-*`, `--ctl-*`)
  and decoration (`--seal`, `--qr`) are all `clamp(floor, min(k·--bh, k·--bw), ceiling)`. Easy
  mode overrides the same tokens; it has no layout of its own (D67).
- **Three compositions, chosen by shape, not by device name**: wide
  (`min-aspect-ratio: 5/4`: the picture beside the controls), tall (one column), short
  (`max-height: 759px`: compact buttons). No user-agent sniffing.
- **Pictures take the room that is left**: the camera preview is `min(100cqw, 100cqh × 4/3)` of
  its stage, the six-print grid computes its width from the stage height, frames are shown whole
  with `object-fit: contain`. Preview = result still holds (4:3, mirrored).
- **Two button sizes, one shape.** L (`.booth-btn-primary` / `-secondary`): at least 80 px tall,
  or 64–80 px when the booth is under 760 px tall. M (`.booth-btn-m`, chrome, segmented): at least
  52 px. Pills, an `:active` state that sinks and darkens, `touch-action: manipulation`, labels
  that wrap instead of clipping. Nothing depends on hover.
- **When the screen is too short** (a software keyboard, Safari toolbars, 1024 × 560): gaps shrink
  first, type and targets stop at their floors, then the screen grows and scrolls inside the booth
  with a hint. An action is never clipped.
- **Safe areas**: padding is `max(token, env(safe-area-inset-*))`; `/kiosk` sets
  `viewport-fit=cover`. Zoom is not disabled.
- **Two screens changed composition** (Figma and D81b said otherwise): frame choice is one large
  preview plus small tiles for every frame (no inner scrolling list); photo review on a wide
  screen is 3 × 2 beside the title and button, not six in one row.
- **Around the layout**: a finger tap in the first 350 ms of a new screen is ignored
  (`lib/kiosk/tap-guard.ts`: a double tap no longer presses the button that appears under the
  finger; touch and pen only). The camera is taken again when the page returns from the background
  (`lib/kiosk/camera-recovery.ts`), and a stream that arrives after the guest has left is stopped
  (`BrowserCamera`). The staff-help corner is hit-tested on the window instead of being an
  overlaid button.
- **Checked by** `e2e/tablet-matrix.spec.ts`: whole sessions at 820 × 1180, 1180 × 820,
  768 × 1024, 1024 × 768, 600 × 960 and 820 × 1060, easy mode at the two iPad Air sizes, rotation,
  a 700 × 460 scroll fallback, a refused camera, a double tap. At every screen: no sideways
  overflow, every control on screen or scrollable to and hit by a touch at its centre, no
  overlaps, no tape or seal on a control, targets ≥ 48 px, 4:3 preview, whole frames, a square
  fully visible QR.
- **Not verified**: anything on a real iPad or in Safari/WebKit. `dvh`, safe-area insets,
  container queries, `@property` and Safari's camera behaviour in the background were only run in
  Chromium at tablet sizes. Full fidelity needs Safari 16.4 or later; older versions get the
  viewport-unit fallbacks, which were written but not run.
- **Left as is**: the idle-warning bar covers the footer while it shows (the first touch
  dismisses it); the staff help panel and `/kiosk/enroll` were not restyled; strip frames leave
  wide empty paper beside the preview on the frame and consent screens.

## D90 · The macOS wall opens on the second display by itself and keeps the Mac awake

Context: the media wall will run on the church's iMac, with the LED (or TV) as its second display.
`start-wall.command` opened Chrome in kiosk mode without saying where, so the wall would most
likely cover the iMac's own screen and leave the LED on the desktop; and only a runbook line kept
the iMac from sleeping.

- **Which screen:** before every (re)open the launcher runs `ops/wall-screen.js` with
  `osascript -l JavaScript` (built into macOS, no install). It reads `NSScreen.screens` and passes
  the chosen screen to Chrome as `--window-position` / `--window-size`; kiosk mode then fills that
  screen. Default `auto`: the largest screen that is not the main (menu bar) one, or the main
  screen when it is alone. The optional second line of `wall-hub.txt` overrides it:
  `screen=main` or `screen=x,y` (a point on the wanted screen). If the screens cannot be read the
  launcher opens as before, on the main screen. The pure choice (`pickScreen`) is unit tested
  (`tests/unit/wall-screen.test.ts`).
- **Any resolution:** the launcher passes no size to the page. The wall already fits its 3840 ×
  1080 scene into whatever window it gets (D65: no stretching; bands top/bottom or sides). Filling
  a screen of another aspect ratio without bands needs a scene designed for that ratio; not done.
- **Awake:** `caffeinate -dimsu -w <launcher pid>` keeps the display and the Mac awake while the
  launcher window is open, and stops with it.
- **Windows unchanged:** `start-wall.ps1` still opens on the primary screen; there the wall PC is
  expected to have the LED as its only or primary display.
- **Not verified:** nothing here has run on a Mac. In particular, that Chrome's kiosk window honours
  `--window-position` on macOS with the profile's saved window state, and the macOS setting
  "Displays have separate Spaces" (on is expected), need the iMac (`docs/DEVICE_ACCEPTANCE.md` D12–D15).

## D91 · A theme can be cut again for another screen shape; the wall picks the closest

Context: the media wall at 성안교회 is the church's mission board, 3096 × 1290 (2.4:1), driven as
the iMac's second display (D90). The wall scene is 3840 × 1080 (3.56:1). Fitted without
stretching (D65) it would fill 3096 × 871 and leave a third of the board as bands, photos at 81 %.
The user asked for any screen shape to apply by itself.

- **Data, not a fork:** a theme may carry `variants`, each a full look (picture, scene, low-spec
  slots, rope, wordmark, empty-wall line). `recutTheme` derives one from the theme's own numbers
  and the cut (`x' = scale · x − left`, `y' = scale · (y + top)`); nothing is measured again, so
  the designer's placement survives. Photos keep their pixel size. Slots whose widest photo
  would leave the picture are dropped.
- **Choice:** `fitTheme(theme, width / height)` takes the theme or the variant closest in shape
  (log ratio). The shape is `WALL_CANVAS` / `?canvas=` if set, else the window. The server, the
  feed, staff settings and rotation still speak theme ids only; the cut is a view. The picture
  fading out during a theme change is cut for the same shape and never stretched.
- **2.4:1 board cuts:** only the four 3:1 originals (S01–S04, 2048 × 682) have the height: they are
  scaled to 1290 rows and cut to 3096 columns (`scripts/wall-backgrounds.mjs` `board`). Three keep
  the right edge of the original so the cross (and the chapel) stay whole; star-of-peace cannot
  keep the cross with four free pegs, so its cut leaves the cross out entirely. Bethlehem hangs on
  the other four pegs (its first is cut off; positions measured in the picture). Each board cut
  hangs four photos. The four 32:9 originals (C01–C04) are too short and keep bands on a board:
  the user's choice (2026-11-14).
- **Checked by** `tests/unit/wall-themes.test.ts` (every rule of every theme also on every cut;
  the line maps through the cut; script and config cut at the same place) and
  `e2e/wall-themes.spec.ts` (a 2.4:1 window: board cut fills it, a 32:9 theme keeps bands).
- **Not covered:** an LED controller that takes a standard signal (1920 × 1080, 3840 × 2160) and
  shows only a region of it. The wall centres its scene in the window; if the board shows, for
  example, only the top-left 3096 × 1290 of a larger signal, an offset setting is still needed.
