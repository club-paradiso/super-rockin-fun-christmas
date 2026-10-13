# Decision log

## D1 · Archive AFTERGLOW on a branch, not in-tree (2026-10-07)

`archive/afterglow-2026-10-07` points at `71a6e62`. The product tree contains only FOLLOW THE
LIGHTS. `main` was created at the same commit as the base for this transition.

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
