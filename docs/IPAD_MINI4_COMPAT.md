# STUDIO SHALOM: iPad mini 4 (iPadOS 15 / Safari 15)

Status: **compatibility hardening, not a certified device pass.**

## Why this needs a special path

Apple's iPad mini 4 remains on iPadOS 15. The main application uses Next.js 16, whose
**officially supported Safari baseline is 16.4**. Setting `browserslist` to Safari 15.6
does not certify the framework runtime on Safari 15. No source change or emulated
desktop browser can prove a physical iPad mini 4 works without testing that hardware.

## Implemented fallback (only for iOS 15)

- iOS 15 iPad UA, including desktop-site mode (MacIntel + multi-touch), enables a
  reduced-memory profile. Desktop Safari on a genuine Mac is unaffected.
- Camera input hint: 1280×720 instead of 1920×1080 (both are `ideal`, not
  hard requirements; the iPad may choose another resolution).
- Captured photograph long edge: maximum 960px rather than 1600px. Photo compositing
  uses design scale 1, typically a **600×1800 JPEG** rather than 1200×3600.
  Frame preview thumbnails also use a smaller scale. Each guest retains all six
  originals and the optional seventh photo.
- Optional session **video recording is disabled** on iOS 15 to protect the
  primary photo and QR workflow from old WebKit memory/encoder failures.
- Legacy browser profile uses a live `visualViewport` height measurement to avoid
  controls being hidden by Safari's browser chrome. Missing `color-mix()` and CSS
  container queries get explicit sRGB, paper, and grid-size fallbacks.
- UUIDs use Web Crypto `getRandomValues()` when `randomUUID()` is unavailable;
  no weak `Math.random()` fallback. No authentication bypass or modified server
  upload/consent behavior.
- The frame picker tolerates a memory-limited browser declining to create a
  thumbnail data URL, rather than taking down the entire kiosk.

## Validation

- `tests/unit/legacy-ios.test.ts` covers normal and desktop iPadOS 15 UAs,
  modern-iPad separation, budget caps, CSS guardrails and cryptographic UUID fallback.
- `e2e/legacy-ipad.spec.ts` runs a complete mock seven-photo → composite → QR
  session at 768×1024, verifies the low-memory 600×1800 output and no page exceptions.
- CI runs this test in Chromium (existing sharded suites) **and modern WebKit**
  (`playwright.webkit.config.ts`). **Modern Playwright WebKit is NOT an iOS 15
  Safari build.** These tests catch regressions but do not replace the hardware test.

## Required real-device acceptance (before relying on event-day operations)

1. On the actual iPad mini 4, update to its latest available iPadOS 15 patch.
   Use Safari and HTTPS (e.g. `https://studio-shalom.vercel.app/kiosk`).
   Ensure the kiosk is enrolled with staff credentials or an issued code.
2. Load the booth from a clean Safari tab. Verify first tap, language switches,
   frame selection, camera permissions, a **live and oriented front-camera preview**,
   front/back camera switching if applicable, and an unobscured capture CTA.
3. Shoot six photos; optionally shoot exactly one more; verify seven previews,
   original six preserved, final selection, 600×1800 JPEG, and a usable QR link on
   a separate phone. Also test choosing NOT to take the optional seventh shot.
4. Rotate landscape/portrait, bring Safari into the background and return,
   and test low-power mode. Confirm the preview recovers and the buttons remain
   reachable under Safari's top and bottom bars.
5. Run at least 10 consecutive full sessions without reloading; watch for
   disappearing controls, unexpected browser reloads, camera black screens,
   high memory pressure, dropped uploads or frozen QR generation.
6. Repeat with the intended kiosk stand, lighting, and Wi-Fi/cellular network.
   The screen "flash" is not an LED flash. If the camera is remote, test phone
   pairing/reconnection separately.

**If this device still fails:** do not use it unattended. Safari 15 is outside
Next.js 16's supported runtime baseline; a **separate, Safari-15-targeted
standalone kiosk bundle** or a newer supported iPad is necessary before a 100%
compatibility claim.

## User-facing trade-off

This mode prioritizes reliable photographs over high-resolution exports and
optional video. On modern iPads, the existing 1600px captures, 1200×3600 exports,
and video recording remain unchanged.
