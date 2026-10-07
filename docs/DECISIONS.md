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
