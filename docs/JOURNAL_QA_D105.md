# D105 · Memory Journal UI and device QA (2026-11-17)

## Scope

KIOSK only. The existing six original captures plus **one optional additional shot**
remain the authoritative capture rule. Never replace an original and never show six
per-photo "retake" buttons in a Figma handoff. The booth's seven progress steps and
the Figma notebook chapter tabs use the same **01–07** numbering (the home choice
is chapter 01 but has no progress fraction).

The 20-frame picker shows the selected frame with a visible check and a
`selected index / 20` badge; it is derived from the current `FRAMES` array,
not a hardcoded ordinal. All nonselected tiles remain selectable.

D104 adds the journal look. D105 refines page arrival to a short, subtle
perspective/page-turn transition; the QR **itself remains still and scan-safe**
while its bookmark decoration moves. For `prefers-reduced-motion` and the
Safari 15 legacy profile, journal animations are disabled. No video, WebGL,
or nonessential font downloads are introduced.

## Automated verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`,
  and `npm run build`
- `e2e/journal-ux.spec.ts`: picker count/selection, optional seventh shot,
  reduced-motion preference
- `e2e/tablet-matrix.spec.ts`: six viewport profiles, including 820×1180
  portrait and 1024×768 landscape; touch targets, clipping, overlaps, and
  journal binding/tab/bookmark collisions
- CI's WebKit legacy profile: adaptive route, iPadOS 15 browser simulation,
  camera recovery/offline retry/QR; **simulation, not physical hardware**

## Real-device acceptance checklist (manual: pending until someone uses the hardware)

On an actual iPad mini 4 (iPadOS 15, Safari 15) and a modern iPad in both
orientations, with the intended camera/QR scan setup:

1. Open `/kiosk` and verify the adaptive frontend, screen orientation,
   diary cover, tap area, and all three language labels.
2. Switch languages; select the first, middle, and last of the 20 frames;
   verify that the check and ordinal match the selected thumbnail and
   that the main CTA remains unobstructed by the journal spine.
3. Grant and revoke camera permission. Confirm recovery and that the live
   preview is not obscured by the page transition.
4. Capture six photos; optionally use the **single** extra-shot action.
   Confirm originals remain intact; confirm the "frame again" step.
5. Select the exact required photos, check selection order, and exercise
   media-wall consent **yes and no**. "No" must not submit to the wall.
6. Scan the QR from a separate phone in portrait and landscape under actual
   ambient event lighting. Verify the white quiet zone, contrast, link,
   download, and that the QR itself does not move or become hidden.
7. Turn on Reduce Motion. Verify the page is usable without animation,
   especially on the legacy frontend.
8. Walk through a complete second session after the first one is cleared;
   make sure no prior photo is exposed to a later visitor.
9. Test a slow/recovering network; upload and fallback UI must remain
   operable, and a slow device must not lose touch interactions.

**Do not mark physical-device QA as complete solely because WebKit/Chromium
simulation passes.** Record device OS, browser version, date, orientation,
screen recording or notes (with guest privacy respected), and any defects.
