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
