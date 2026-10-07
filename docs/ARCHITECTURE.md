# Architecture

One Next.js application serves all surfaces. No microservices.

```
 ┌──────────── Kiosk browser (/kiosk) ─────────────┐
 │ CameraProvider ─► grabFrame (crop+mirror)       │
 │        │                                         │
 │ kioskReducer (pure) ◄── KioskApp effects         │
 │        │                                         │
 │ composeFrame(FrameDefinition, 4 images) ─► JPEG  │
 │        │  POST /api/photos (x-session-id)        │
 └────────┼─────────────────────────────────────────┘
          ▼
 ┌──────────── Next.js server ─────────────────────┐
 │ /api/photos        → PhotoStore.put  → token     │
 │ /api/photos/consent→ PhotoStore.setWallConsent   │
 │ /p/[token]         → mobile page                 │
 │ /p/[token]/image   → image bytes (no-store)      │
 │ PhotoStore: LocalPhotoStore (P1) | Supabase (P2) │
 └──────────────────────────────────────────────────┘
          ▲ QR
     Guest phone
```

## Kiosk

- **`lib/kiosk/machine.ts`** — pure reducer for the whole session. Rules live here (exactly four
  shots, stray frames ignored, retake one/all, three capture failures → camera error, reset,
  consent independent of delivery). No timers, no DOM.
- **`components/kiosk/kiosk-app.tsx`** — runs side effects keyed on phase: start/stop camera,
  1 s countdown ticks, capture, compose, upload. Dispatches results back.
- Camera is stopped on welcome and after review, so the camera light is off when idle.
- Object URLs for shots and the final image are revoked on reset.

## Camera

`CameraProvider` (`lib/camera/types.ts`): `start(deviceId?)`, `stop`, `isActive`, `getStream`,
`capture(options)`, `listDevices`, `onDisconnect`.

- `BrowserCamera` — `getUserMedia` (ideal 1920×1080, user-facing or a chosen device),
  error mapping to `denied | missing | unsupported | failed`, track-ended → disconnect.
  Capture uses a private `<video>` so it does not depend on the preview being mounted.
- `MockCamera` — draws a generated 16:9 scene on a canvas; streams it via `captureStream`
  when available. Selected by `?camera=mock` or `NEXT_PUBLIC_CAMERA_MODE=mock`.
- `grabFrame` — the single crop/mirror implementation used by both. The preview uses the same
  aspect box with `object-fit: cover` and the same mirror flag.

## Compositor

`composeFrame(frame, images, { createCanvas, context, scale })`: background → each photo
cover-cropped and clipped into its slot (rounded corners, optional border) → decorations
(`text` with `{date}`, seeded `stars`, `lights` strands, `rect`). Throws unless the image count
equals the slot count. `scale` renders frame-picker thumbnails from the same code.

Canvas access goes through `CanvasFactory` so unit tests use a recording fake.

## Delivery and storage

- Upload: raw JPEG body; headers `x-session-id` (UUID, idempotency key) and `x-frame-id`.
  Validated: MIME, magic bytes, size ≤ 15 MB, known frame.
- Token: 192 random bits, base64url. Stored only as SHA-256; files are named by hash.
- `LocalPhotoStore` writes atomically to `FTL_DATA_DIR` (default `.data/`).
- Client retries network/5xx up to three times; 4xx is final. The same session id makes
  retries return the same token.
- Consent: `none ⇄ PENDING`; moderation states are reserved for the admin surface.

## Known Phase 1 limits

- Upload API is unauthenticated. Run Phase 1 only on a trusted network.
- Local store is not reachable from guest phones on the public internet.
- Retention cleanup job is not implemented yet (expired links already return 404).
- If the kiosk reloads mid-session, that session is lost (no local persistence yet).
