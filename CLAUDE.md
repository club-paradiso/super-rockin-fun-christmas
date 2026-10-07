# CLAUDE.md — FOLLOW THE LIGHTS

Web four-cut photo booth + participatory media wall for Christmas Village 2026.
Next.js 16 (App Router) · TypeScript strict · Tailwind 4 · Vitest · Playwright.

## Non-negotiables

- **No printing.** No printer, print queue, print layout. Delivery is QR → guest's phone.
- **No personal contact collection.** No phone, email, account, SNS login. A QR token is enough.
- **Download and wall consent are independent.** Declining the wall must never affect the photo
  link. Consent UI gives both answers equal weight — no dark patterns.
- **No face recognition, biometrics, or analytics.** Store only what the service needs.
- **Moderation is human.** No AI moderation.
- **Vendor-neutral.** Do not invent MY4CUT (or any vendor) APIs. Hardware is a shell.
- **Preview = result.** Preview and capture share `KIOSK_CONFIG.captureAspect` and
  `KIOSK_CONFIG.mirror`. Never stretch an image; crop with `coverCrop`.
- **Frames are data** in `config/frames/`. Don't hard-code layout in the compositor.

## Layout

```
app/kiosk          booth (client component in components/kiosk)
app/p/[token]      phone download page + image route
app/api/photos     upload (idempotent per session) and consent
app/wall, admin    placeholders until Phase 3/4
lib/camera         CameraProvider: BrowserCamera, MockCamera, shared grabFrame
lib/compositor     FrameDefinition types, coverCrop, composeFrame
lib/kiosk          pure state machine, session helpers, delivery client
lib/storage        PhotoStore port, LocalPhotoStore, token utils
lib/qr             download URL + QR SVG
config/            kiosk knobs and frame definitions
tests/unit         Vitest (jsdom; FakeCanvas helper records 2D calls)
e2e/               Playwright happy paths
```

## Working rules

- Keep kiosk rules in `lib/kiosk/machine.ts` (pure reducer) and test them there. Components only
  run effects and dispatch.
- Anything touching canvas takes a `CanvasFactory` so it is testable with `tests/helpers/fake-canvas.ts`.
- Kiosk copy: short Korean, large touch targets (`btn-primary`/`btn-secondary` are ≥ 80px tall).
- Before committing: `npm run check`. Before claiming a flow works: `npm run test:e2e`.
- Develop without a camera via `/kiosk?camera=mock`.
- Never commit `.env*.local`, `.data/`, or guest photos.
- Don't call anything "production ready" without real-device verification (see ROADMAP).
