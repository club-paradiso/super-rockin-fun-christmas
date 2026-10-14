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
ATTRACT → PICK A FRAME → CAMERA → COUNTDOWN → 4-CUT CAPTURE → REVIEW → (RETAKE)
       → FRAME AGAIN (with the guest's photos) → MEDIA WALL QUESTION → QR → DOWNLOAD
separately:  WALL "YES" → MODERATION → APPROVED → MEDIA WALL
```

The header shows the step, `N / 6` (five steps while staff pause wall submissions, because the
question is skipped). The upload starts when the frame is final, while the guest answers the wall
question, so the QR is usually ready the moment it is answered.

Download and public consent are independent. Saying no to the wall never affects the download.

## 4. Requirements

### Kiosk (`/kiosk`)

Screens (Figma `01 Platform — Booth & Admin`, 01–07): attract ("화면을 눌러 시작"), frame choice
("이 틀로 찍기"), camera permission, preview and countdown, review with one retake button per photo,
frame choice again with the guest's photos in every frame ("사진을 넣어 봤어요", the first choice
preselected, "이 틀로 할게요"), media-wall question beside the finished strip, QR ("휴대폰으로 사진을
받아 가세요", session code under the QR, "다 받았어요"), auto reset.

- Exactly four captures per session; visible progress (`2 / 4`).
- Preview crop and mirror equal the saved photo.
- Camera errors (denied, missing, unsupported, failed, disconnected) have plain-language screens
  with retry and "start over".
- Idle sessions reset; the QR screen returns to the attract screen after the same idle time.

### Four-cut engine

- Frames are data (`FrameDefinition`: id, name, output size, background, slots, decorations).
- Exactly four frames, Figma `02 네컷 Templates` A–D: 남색 (Navy Strip), 창틀 (Wood Window),
  빨랫줄 (Clothesline), 크림 (Cream Strip). 600 × 1800 design, saved at 2× (1200 × 3600), four
  4:3 photos with square corners, no QR inside the image.
- Deterministic output; photos are cover-cropped, never stretched.

### Phone delivery (`/p/[token]`)

- Random, non-sequential token; storage paths never exposed; expiry; no login.
- Mobile-first page with save and share; friendly page for expired/unknown links.

### Public consent

- Asked before the QR: "이 사진을 미디어월에 띄워도 될까요?" → "네, 띄워주세요" /
  "아니요, 저만 볼게요", same size and style. The screen says "아니요를 눌러도 사진은 받아볼 수
  있어요." The QR screen adds "잠시 뒤 큰 화면에서 내 사진을 찾아보세요." only after a yes.

### Moderation (`/admin`) — Phase 3

States: `PENDING`, `APPROVED`, `REJECTED`, `HIDDEN`, `DELETED`. Human review only.
Functions: pending list, approve, reject, hide, restore, delete, recent sessions, kiosk/wall/
storage health. Emergency: PAUSE SUBMISSIONS, PAUSE MEDIA WALL, SHOW HOLDING SCREEN.
Hiding a photo from the wall asks first ("<세션> 사진을 미디어월에서 숨길까요?") and offers a 5-second
undo ("<세션> 사진을 숨겼어요." [되돌리기]). Labels are Korean, in the audit log too.

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
