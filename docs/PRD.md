# PRD — FOLLOW THE LIGHTS

Christmas Village 2026 · Four-Cut Photo Booth × Participatory Media Wall

> 한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다.

## 1. Problem and intent

A church Christmas Village wants a photo moment that is more than a photo booth: each visitor
takes something home, and the community sees itself gathered on one wall. It must work for
children through older adults, on unreliable venue Wi-Fi, without collecting personal data.

## 2. Users

- **Guests** — families, children, older adults. Touch-first, short Korean text, big buttons.
- **Volunteers/staff** — keep the booth running, moderate the wall, handle emergencies.
- **Display** — an unattended full-screen wall.

## 3. Core experience

```
WELCOME → CAMERA → COUNTDOWN → 4-CUT CAPTURE → REVIEW → (RETAKE) → FRAME → FINAL PHOTO
       → GET ON MY PHONE → QR → DOWNLOAD
separately:  PUBLIC MEDIA WALL CONSENT → MODERATION → APPROVED → MEDIA WALL
```

Download and public consent are independent. Saying no to the wall never affects the download.

## 4. Requirements

### Kiosk (`/kiosk`)

Screens: welcome, camera permission, preview, countdown, capture progress, review, retake (one or
all), frame selection, final preview, phone delivery, QR, media-wall consent, complete, auto reset.

- Exactly four captures per session; visible progress (`2 / 4`).
- Preview crop and mirror equal the saved photo.
- Camera errors (denied, missing, unsupported, failed, disconnected) have plain-language screens
  with retry and "start over".
- Idle sessions reset; the complete screen returns to welcome automatically.

### Four-cut engine

- Frames are data (`FrameDefinition`: id, name, output size, background, slots, decorations).
- Deterministic output; photos are cover-cropped, never stretched.

### Phone delivery (`/p/[token]`)

- Random, non-sequential token; storage paths never exposed; expiry; no login.
- Mobile-first page with save and share; friendly page for expired/unknown links.

### Public consent

- "내 사진을 Christmas Village 미디어월에도 보여줄까요?" → "네, 함께 보여주세요" /
  "아니요, 사진만 저장할게요", equal visual weight.

### Moderation (`/admin`) — Phase 3

States: `PENDING`, `APPROVED`, `REJECTED`, `HIDDEN`, `DELETED`. Human review only.
Functions: pending list, approve, reject, hide, restore, delete, recent sessions, kiosk/wall/
storage health. Emergency: PAUSE SUBMISSIONS, PAUSE MEDIA WALL, SHOW HOLDING SCREEN.

### Media wall (`/wall`) — Phase 4

Screen states: `BOOT`, `EMPTY`, `ACTIVE`, `OFFLINE`, `MAINTENANCE`. Photo lifecycle:
`ENTER → VISIBLE → EXIT → COOLDOWN`. Photos appear inside a Christmas Village night scene —
explicitly not a slideshow.

## 5. Out of scope

Printing of any kind; contact collection; accounts; face recognition or any biometric
processing; analytics; AI moderation; multi-event SaaS; proprietary vendor integrations.

## 6. Privacy

- Store: final image, frame id, timestamps, expiry, wall status, random session id.
- Do not store: names, contacts, device fingerprints, individual raw shots on the server.
- Retention is configurable (`PHOTO_LINK_TTL_HOURS`, `PHOTO_RETENTION_DAYS`).

## 7. Reliability

Assume Wi-Fi fails. The kiosk must never dead-end: uploads retry, duplicates are prevented by a
per-session idempotency key, the offline state is visible, and the guest can always finish.

## 8. Success criteria (event)

- A first-time guest completes a session without staff help.
- No session loses a photo because of a single network failure.
- Zero unmoderated photos on the wall.
