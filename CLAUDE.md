# CLAUDE.md — STUDIO SHALOM

Web four-cut photo booth + participatory media wall for Christmas Village 2026.
Next.js 16 (App Router) · TypeScript strict · Tailwind 4 · Vitest · Playwright.

## Transition in progress (read first)

Read `docs/STATUS.md` first. A local-first redesign is proposed in `docs/ARCHITECTURE.md` part 1
(decisions D39–D48): an on-site hub becomes the source of truth, the cloud keeps only a QR copy,
and staff sign in with a PIN on the hub. Until that work lands, the rules below describe the code
as it is. Change each rule in the same PR that changes the behaviour it describes.

## Non-negotiables

- **No printing.** No printer, print queue, print layout. Delivery is QR → guest's phone.
- **No personal contact collection.** No phone, email, account, SNS login. A QR token is enough.
- **Download and wall consent are independent.** Declining the wall must never affect the photo
  link. Consent UI gives both answers equal weight — no dark patterns.
- **No face recognition, biometrics, or analytics.** Store only what the service needs.
- **A person can always decide; the AI may only approve** (D95, a user decision that replaced
  "no AI moderation"). `moderationMode` is `auto` (the default since 2026-11-25, a user decision:
  a photo the AI finds clearly fine goes up at once; migration `20261125120000` switches an existing
  database only if staff never set the mode) or `manual`; there is no mode without review. With no
  AI provider configured, `auto` is inactive and every photo waits for a person. The E2E run starts
  in `auto` (`e2e/global-setup.ts` checks it) and sets `manual` for the specs. In `auto` the AI looks at every photo whose guest said yes to the wall (D96, a user
  decision: the booth does not announce the check, so there is no notice flag; it tells every guest
  instead that staff can hide a photo; after a yes the QR screen shows the wall status line,
  checking → 올라갔어요 only once the server says APPROVED → 지연 when slow or handed to a person,
  never naming the AI: `.wall-status`, Figma 969:1690), and the only thing it can do is move PENDING → APPROVED, through
  `AiReviewRepository.complete` with SAFE (`ftl_ai_complete`): one atomic, audited call. Unsafe,
  unsure, error, timeout, rate limit, no budget, no configuration → the photo stays PENDING for a
  person. Never add a path where "could not check" becomes approved, never let the AI reject,
  hide, delete or restore, and never add a route that accepts a verdict. Phone uploads (D66) go
  through the same review since 2026-11-25 (a user decision): queued after the upload, or on the
  hub when it takes one in from the cloud inbox (never on the cloud for a hub's inbox photo); a
  phone photo in a booth frame is cut with that frame's slots, a plain one is one shot
  (`prepareStoredPhotoShots`). The policy is `lib/moderation/policy.ts` + `prompt.ts`, never the
  provider's own.
- **Only prepared copies leave the server, one per shot** (D95, D97): `prepareModerationShots` cuts
  a composed photo into its shots with the frame's slot data (small JPEGs, no metadata), and each
  goes out in its own request with the fixed prompt. Never send the whole strip instead: measured
  against a real provider, that approved a raised middle finger in one shot of four. The photo is
  SAFE only when every shot is; a photo that cannot be cut up (unknown frame, wrong shape) waits
  for a person. An adapter (`lib/moderation/providers`) receives one such image and
  an abort signal, nothing else: no ids, sessions, tokens or paths. Store and log category and
  reason codes only, never a provider's text. A new provider is one adapter plus one line in
  `lib/moderation/server.ts`. A wrong AI setting turns the AI off (`aiModerationProblem`); it must
  never be a `ConfigError`, because the booth works without it.
- **A fallback provider only stands in for the primary** (D98, a user request): `AI_MODERATION_FALLBACK_*`
  is asked only when the primary's daily limit is used up or it answered `rate_limited`, and it never
  draws on that limit. A flag from the primary is never re-asked; one provider answers for a whole
  photo and is the one recorded. Same prompt, same shots, same single approval path; off, slow or
  unsure means PENDING for a person. A whole photo on the fallback finishes within
  `fallbackPhotoBudgetMs`. A wrong fallback setting turns only the fallback off
  (`aiModerationFallbackProblem`), never a `ConfigError`.
- **Vendor-neutral.** Do not invent MY4CUT (or any vendor) APIs. Hardware is a shell.
- **Preview = result.** Preview and capture share `KIOSK_CONFIG.captureAspect` and
  `KIOSK_CONFIG.mirror`. Never stretch an image; crop with `coverCrop`. The v2 frames (below) have
  slots of other shapes (square, oval, Figma sizes): the 4:3 shot is cover-cropped into them.
- **Looks are on by default, behind a staff switch** (2026-11-23, `lib/looks`; on by default since
  2026-11-25, a user decision: the guest must be able to choose a colour,
  `docs/research/`): eight looks, each the house stock (`HOUSE` in `config/looks/index.ts`) plus
  differences, baked to `public/looks/<id>.cube` by `npm run looks:build` (never hand-edit a
  `.cube`; `tests/unit/looks-cube.test.ts` fails while file and numbers disagree). One WebGL1 shader
  (`lib/looks/shader.ts`) applies halation (small lights only), the LUT, strength, grain and corner falloff; the frame previews
  and the final composite pass the same `grade` to `composeFrame`, so their colours cannot differ.
  Which frame gets which look is `config/looks/frame-looks.json`, never code. With looks off the booth fetches no LUT, creates no WebGL
  context and composes as before; that is what the Figma parity tests measure, so they load the
  booth with `?looks=0` (Figma has no look). What turns them on (`looksActive`): the address
  (`?looks=1` / `?looks=0`, which wins), else the build (`NEXT_PUBLIC_LOOKS=1`) or the staff switch
  「사진 색 보정」 (`settings.photoLooks`, audited through `ftl_settings_set_looks`, default **on**;
  migration `20261125090000` turns an existing database on only if staff never set it). The
  switch reaches a booth with its heartbeat and is taken up only on "화면을 눌러 시작"
  (`sessionLooks`): never under a guest. **The guest may change the look on the photo choice screen, and nowhere
  else** (a user decision, 2026-11-24, Figma 956:1589 / 956:1715): a row of the eight looks, four at
  a time with "다음" (`LOOKS_PER_PAGE`, `LookRow`), each on the guest's own first shot, opening on
  the frame's own look, which stays the answer if the guest touches nothing. No extra screen and no
  extra step; `lookId` + `SET_LOOK` in `lib/kiosk/machine.ts`, only in phase `select`, null again
  for the next guest. The row is all or nothing: with looks off, a LUT missing or WebGL failed it
  is not shown. Its names are in `lib/kiosk/copy.ts` (`select.looks`, placeholders until the user
  gives wording). With looks on, the six shots on the review and choice screens are shown in the
  session's look (`gradedShots`, the same grader as the print; `chosenLook`), and the live camera picture of a
  black-and-white or sepia frame is shown that way with a CSS filter on the `<video>` only
  (`lookViewForFrame`); a colour look never changes the camera view. Staff read the state on the
  booth in the help menu (`lib/looks/status.ts`). When WebGL fails the photo keeps the frame's own
  `photoTone` and the reason goes to the console (`[looks]`) and, as a code, to the server log
  with the heartbeat (`kiosk_looks_failed`): never silently, never a blocked guest. A failure is
  never permanent (2026-11-26): a failed render is tried once more on a fresh renderer (the old
  context is released), and `newSession()` on "화면을 눌러 시작" tries WebGL again for the next
  guest, so one lost context (iPad sleep, memory pressure) cannot hide the colour row all day.
  Every look keeps the bars in `tests/unit/looks-engine.test.ts` (skin hue within 6°, reds and
  greens never more vivid, white short of clipping, black 2–12 levels) and stays plain to tell
  from the others (`tests/unit/looks-distinct.test.ts`: every pair at least 4.5 ΔE00 apart on the samples; `npm run
looks:measure`). `/looks` is the comparison
  sheet, a stand-alone bundle (`looks-sheet/`) so it opens on Safari 15; its samples are synthetic
  or drawn, never a guest's photo. No face detection, no retouching: a look is colour only.
- **The frame is chosen before shooting and fixed after it** (틀 선택 v2, 2026-11-22): the booth
  offers the nine cards of `config/frames/v2.ts` (the seven of Figma 898:1677, then 필름 35mm
  4컷, Figma 924:2026, added 2026-11-24, then 밈 4컷, added 2026-11-26: the five meme frames of
  Figma SS 02 "01 · 최종 후보", 14-C · 15 · 16 · 17 · 18-B; 18 "네온 스캔 HUD", the black one, is
  left out by a user decision); a card with options (colour, logo, meme) has an options screen,
  and an option may have two answers or more (필름 35mm: 컬러 / 흑백 / 세피아; 밈 4컷: five, three
  to a line); the picker shows the nine five to a row; the guest then shoots six, reviews, chooses the photos. There is no
  "one more shot" and no second frame choice after shooting (`lib/kiosk/machine.ts`). The one way
  past the shots is 「다시 찍기」 on the review screen (a user decision, 2026-11-25): it asks first,
  throws all six away (and the session video) and shoots six again in the same frame,
  `KIOSK_CONFIG.retakesPerSession` times (1); never once the photos are chosen. Every option
  combination is its own frame id. 폴라로이드 1컷 has a 문구 option (2026-11-26, a user decision,
  Figma 877:1665 / options screen 1055:3631): ten captions; only the first (`polaroid1`, the id photos
  were stored under) draws the per-session random handwriting. Every other caption is Figma's own,
  never a random font: outlined caption SVGs, and 「오늘 날짜」 in a fixed Caveat (`hand.font`,
  `{handDate}`, the server's day). The earlier 20 frames (`FRAMES`) stay only for photos already
  stored; neither the booth nor the phone page offers them (D113).
- **Frames are data** in `config/frames/`. Don't hard-code layout in the compositor. Every frame
  of `FRAMES` keeps the legible lockup rule in `tests/unit/frames.test.ts`; the v2 frames keep the
  Figma logo (two-line lockup at its Figma size, below every photo, ≥ 3:1 contrast; 필름 3컷 "로고
  빼기" has none, the guest's choice; the 밈 4컷 frames carry the logo their Figma frame draws,
  inside their art, `isMemeFrame`) in `tests/unit/frames-v2.test.ts`; art over the photos is a
  vector overlay exported from Figma (`*-overlay.svg`): Figma's export writes a shadow "spread"
  (`feMorphology`) that Figma itself does not draw on text, so take it out of text layers' filters; mirror frame changes in
  Figma (`design/README.md`). Photo tones (흑백/세피아, 폴라로이드 3컷's
  "플래시 느낌", 필름 35mm's "컬러") are pixel arithmetic in `lib/compositor/tone.ts`, never `ctx.filter` (Safari 15 has
  none); their curves were measured from Figma exports, so change one only with a new measurement. The handwriting font is drawn
  per session (`config/hand-fonts.ts`), never the previous session's; the polaroid date stamp is the
  server's day (`lib/kiosk/clock.ts`), never the tablet clock.
- **The brand is STUDIO SHALOM** (D73; lockup `STUDIO` / `SHALOM` / divider / `평화의 벽`, event
  "Christmas Village 2026", verse reference "Matthew 5:9" and approved English verse in the Shalom 2×2 frame). Colours are the tokens in
  `app/globals.css` (`backdrop`, `ink`, `button`, `button-text`/`paper`, `accent`, plus the staff
  status colours): no other brand colours, no gradients or glow, one filled button per view (the
  v2 options screen marks the chosen answer filled, as in Figma; it is a state, not a second action),
  `accent` as text only at ≥ 24 px, never `button-text` on `backdrop`. The on-screen lockup is real
  text (`components/brand.tsx`); frames use outlined SVG paths. The media wall keeps its night
  scene with its own `--wall-*` palette (`.wall-stage`). Internal identifiers keep the old name
  (`FTL_*`, `ftl_*`, IndexedDB `follow-the-lights`, wall browser profile folders, package name):
  renaming them breaks deployed hubs or loses queued uploads.
- **No secrets in the browser.** Never add `NEXT_PUBLIC_` to a secret. Kiosk auth is the
  HttpOnly cookie from `/kiosk/enroll`; the browser never talks to Supabase.
- **Private photos.** Bucket stays private; guests only ever see `/p/[token]`,
  `/p/[token]/image` and `/p/[token]/video`. Never return `objectPath`, `tokenHash` or signed
  storage URLs to clients.
- **Raw tokens are never stored or logged.** Only `sha256(token)`. Unknown/expired/deleted all
  return the same 404.
- **No fake QR.** A QR is shown only after the server returned a real token.
- **Schema changes are migrations** in `supabase/migrations/`, never console clicks.
- **/admin opens with the kiosk enrollment password** (D84, a user decision: never add a separate
  administrator password). `POST /api/admin/auth/password` → HttpOnly `ftl_admin`
  (`lib/staff-auth/shared.ts`): its own cookie and its own MAC key, bound to both
  `KIOSK_SESSION_SECRET` and `KIOSK_ENROLL_SECRET`, acting as the fixed `SHARED_OPERATOR` (never a
  staff row, never a real person's id). Refused when the password is shorter than 12 characters.
  Every password check goes through `checkAdminPassword` and `adminPasswordLimits`.
- **Personal staff login = a session + an active staff row** (the fallback, `/admin/login?staff=1`),
  checked server-side on every page
  (`requireStaff`) and API (`staffRoute`), through `authorizeStaffRequest` / `getStaffForPage`,
  which accept the shared session first.
  Cloud: Supabase Auth email OTP (a Supabase user alone is nothing; no signups). Hub
  (`FTL_ROLE=hub`): name + 6-digit PIN, scrypt-hashed in `StaffRepository.setPin`, never returned
  by `list()`/`get()`; first staff only via the console setup code (`lib/staff-auth/setup.ts`).
- **Kiosk and staff auth never substitute for each other**, even though the booth and /admin now
  share one password. Kiosk APIs read only the kiosk cookie; staff APIs read only a staff session
  (`ftl_admin`, Supabase cookies or `ftl_staff`). Each cookie's MAC key is derived with its own
  label. Enrolling never signs in; signing in never enrolls. Booth help mode (`/api/kiosk/help`, D59)
  checks a staff PIN but issues no session; every PIN check goes through `attemptStaffPin`.
- **Every state change is audited atomically**: moderation, deletion, token rotation, kiosk
  rename/revoke, enrollment codes, settings, staff changes go through ONE backend call (a SQL
  `ftl_*` function on Supabase). Never update those columns directly.
- **Moderation rules live in `lib/ops/moderation.ts`.** APPROVED requires wall consent; DELETED is
  terminal and removes the image. The AI's opinion is a separate record (`photo.ai`, D95), never a
  moderation state, and a queued photo that leaves PENDING is out of the AI's hands (`photos_guard`
  trigger / `aiAfterLeavingPending`). No face anything.
- **PAUSE SUBMISSIONS never blocks photography or QR delivery** — only new wall consent.
- **The wall page needs no enrollment; the feed decides what each viewer gets** (D86). A valid
  kiosk cookie is an enrolled venue display: it receives `wall_eligible_photos` ids, through
  `/api/wall/feed`, and it alone may report (`/api/wall/shown`, heartbeat). Anyone else is the
  public audience (`lib/wall/audience.ts`): only `wall_public_photos` ids (the wall rule AND
  `photos.wall_public`), newest first, and none while `settings.wallPublic` is off (the default).
  `wall_public` is set only by the consent transition, only with a YES given while the public-wall
  line was on screen and the switch was on; a NO clears it; nothing else may ever set it.
  PAUSE WALL and SHOW HOLDING SCREEN are applied on the server for both audiences, and so are the
  opening hours (`wallOpen` in `lib/wall/hours.ts`, D62): outside them the feed is `closed` and
  sends no ids. Never give the wall anon database access, tokens or storage URLs.
- **Wall themes are data** (D85): `config/wall-themes.ts` + a picture in `public/wall/themes/`
  (`scripts/wall-backgrounds.mjs`). Never branch on a theme id in `components/wall`. Every theme
  must pass `tests/unit/wall-themes.test.ts` (every frame format inside the picture, neighbours
  apart, wordmark never behind a photo). The active theme comes from the feed
  (`activeThemeId`, a function of the staff setting and the clock). The old FOLLOW THE LIGHTS
  scene (`night-window`) was removed (D116): a stored id that no longer exists falls back to the
  default theme. A theme may carry `variants`: the same
  picture cut for another screen shape (D91, the 2.4:1 board), derived with `recutTheme` from the
  theme's own numbers. Every variant passes the same theme tests.
- **The wall fits any screen by itself** (D110): `planWallFit` (`lib/wall/fit.ts`, pure) fits the
  photos and the wordmark, not the whole picture, choosing the cut and the run of slots per screen.
  The wordmark is the wall's own logo (D117: 평화의 벽 · THE WALL OF PEACEMAKERS, Figma SS 00,
  `public/wall/logo-stack.svg` basic form or `logo-line.svg` one-line form, `WALL_LOGO`; each
  picture picks one in `theme.wordmark.form`, so the logo changes with the background) at its own place in each picture
  (`theme.wordmark`, `plan.mark`, D116: under a star, painted on plaster, burned into a sill, a tag
  on a garland), moving with the picture, never with the screen, and clear of every photo and clip
  on every screen. Nothing hangs a clip over the line elsewhere: every theme uses tape (D115). A screen that
  enlarges the scene gets the theme's `background2x`; low-spec mode never does.
  Never stretch, never zoom past covering the screen, bands only where the photos need them (filled
  with the blurred picture, `.wall-ambient`). Any new wall look or slot change must keep
  `tests/unit/wall-fit.test.ts` green. The wall re-plans on resize/fullscreen without a reload.
- **전체화면 on the wall: one way in, only Escape out** (a user decision, 2026-11-25,
  `lib/wall/fullscreen.ts`, `components/wall/fullscreen-button.tsx`). A browser opened by hand gets
  the 「전체화면」 button (bottom right, says "끌 때는 Esc"), only while the window does not cover the
  screen and the pointer moved in the last few seconds; a double-click or F also go in. Nothing on
  the wall ever leaves fullscreen (no toggle): Escape, the browser's own, is the only way out. While
  the wall covers the screen (Fullscreen API, `--kiosk`, F11) nothing is drawn over it and the
  cursor is hidden. Keep `e2e/wall.spec.ts` 「전체화면」 green.
- **The wall's pace is a staff setting** (D92): `showSeconds` and `halfLifeMinutes` live inside the
  audited `wallLook`, reach the wall as the feed's `pace`, and are changed with
  `{"wallPace"}` (saving a background keeps them). The half-life only changes how often a photo
  comes up (`ageWeight` in `lib/wall/rotation.ts`); it never removes one, and with it off the
  order is exactly the fair order.
- **The phone page goes in the booth's order** (D103): frame first, then exactly as many photos
  as it holds in tap order, then the booth's yes/no wall question with equal weight. "No" sends
  nothing and both answers can save the framed picture on the phone. Never make the wall answer a
  condition for getting the picture, and never send it without "yes".
- **Phone uploads (D66) are ordinary photos** whose `frame_id` starts with `phone-`
  (`config/mobile.ts`): `phone-<booth frame id>` when the guest put photos in one of the booth's
  v2 frames on the phone (D93, D113: the booth's nine cards and options, `MOBILE_FRAMES`; composed there with `composeFrame`, shape checked on the server, hung on
  the wall like that frame; each photo sits in its slot where the guest dragged it,
  `ComposeImage.focus` = CSS `object-position`, starting a third from the top,
  `MOBILE_UPLOAD_CONFIG.defaultFocus`; booth shots carry no focus and stay centred), `phone-photo` for a plain photo from a page older than D93. Test a phone
  photo with `isMobilePhoto`, never by comparing to one id. One picture per booth QR (the signed `lib/mobile/token.ts` session id is the photo's unique
  `session_id`), re-encoded on the server (`lib/mobile/image.ts`: no EXIF/GPS), entering review
  as PENDING only through `PhotoService.putMobile` with explicit consent. No guest link, no QR
  reissue. Never add a path that makes one APPROVED or wall-visible outside `lib/ops/moderation.ts`.
- **Session video is best-effort and silent** (D72): never request or record audio. Recording
  (`lib/kiosk/recorder.ts`), its upload (`/api/photos/video`, not queued offline) and its cloud
  copy must never delay, block or fail photography, the photo upload, wall consent or the QR. MP4
  or WebM only, magic bytes checked, at most `KIOSK_CONFIG.videoMaxBytes` on the kiosk and on every
  route (413). Its object path is derived from the photo's (`videoPath`), so whatever removes a
  photo's image removes its video. No "video ready" UI unless the server has one. Phone uploads
  never have a video; the wall never receives a video, a video URL or a flag about one.
- **The cloud is only a QR copy** (D40, D43, D57) **plus a transient phone-upload inbox** (D66): the
  hub takes each phone photo (`HubInbox`) and the cloud deletes it on `ack`. A hub with `CLOUD_BASE_URL` shows the cloud's
  guest link and never stores it; consent, moderation and exposures never go to the cloud. All
  cloud calls go through `CloudSync` (one call per photo at a time: a second upload would reissue
  the token and kill a scanned QR). The session video follows the photo copy with `putVideo`, which
  never issues a token (D72). A hub delete must reach the cloud (`markDeleted`). The cloud's
  `/api/hub/*` only touches copies with `kioskId` null; a copy deleted there is final (410).
- **The dedicated wall address is a hostname, not a second app** (D68): `WALL_HOSTS` +
  `lib/wall/host.ts` in `next.config.ts`. No second database, no wall-only backend.
- **There is one booth screen** (D89 removed easy mode, D67). No second "easy" or "large" variant:
  a new per-guest option is a view in `lib/kiosk/machine.ts`, never a copy of the shooting,
  selection, consent or upload rules.
- **The pose guide is a view too** (D71): `poseGuide` + `currentPose` in `lib/kiosk/machine.ts` only
  decide what the countdown shows. Poses are data in `config/poses.ts` (one per shot, text only; no
  invented art). Every shot counts `KIOSK_CONFIG.countdownSeconds` (5 s, a user decision 2026-11-26).
  `NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS` is for the E2E build only.
- **The booth language is a view too** (D78, D89): `lang` in `lib/kiosk/machine.ts` (Korean,
  English or Simplified Chinese; every guest starts in Korean). Every guest string lives in
  `lib/kiosk/copy.ts` in all three languages; never hard-code booth copy in a component. A frame
  or pose carries `label`, `labelEn` and `labelZh`; read them with `localizedLabel`. Chinese needs
  `:lang(zh-Hans)` (own font, no `word-break: keep-all`): keep `<html lang>` on `HTML_LANG`. Korean copy is the user's wording (D76). "이전" exists only
  where `canGoBack` allows it, a step that loses nothing: frame pick → welcome, options → pick,
  camera before the first shot → options, photo choice → review (the choice kept), phone QR →
  welcome; never during shooting, on the review, or once the photos are chosen. It sits in the
  footer beside "처음으로" (a user decision, 2026-11-25; Figma `Kiosk/Footer` Type=HomeBack),
  never in the header.
- **The booth is a ring-bound memory journal** (D104): the `LetterSheet` export and
  `data-testid="letter-sheet"` remain for compatibility, but the kiosk UI shows a leather-look
  journal cover, binder rings, numbered chapter tabs and a QR bookmark. See the
  `journal-*` selectors at the end of `app/globals.css` and `JournalBookmark` in
  `components/kiosk/ui.tsx`. The old wax-seal asset is **not shown on kiosk screens**; it is
  preserved only for frame artwork that explicitly uses it. The paper still uses the faded tone,
  grain and ruled lines of D81. `Tape`, `PhotoCorners` and binder parts are inert decorations
  (`aria-hidden`, no pointer events, no extra scrolling). The frame-picker, QR generation,
  guest copy, consent and camera state machine do not change. Respect
  `prefers-reduced-motion`; iPad mini 4 / Safari 15 disables journal entrance animations.
- **The booth has one layout system** (D88): `main.kiosk-root` is the viewport and a size
  container, `.kiosk-scroll` is the only scroll area, and every size comes from the tokens in
  `app/globals.css` (`--bw`/`--bh`, `--gap-*`, `--fs-*`, `--btn-*`, `--ctl-*`). Never size a booth
  element from raw `vh`/`vw` or a fixed pixel height, never add a device-name or user-agent
  branch, never a second scroll area inside a screen. Compositions switch by shape (wide / tall /
  short). Any booth change must keep `e2e/tablet-matrix.spec.ts` green.
- **The progress dots count the steps this session really has** (a user decision, 2026-11-24):
  six with the wall question, five when it is skipped (PAUSE SUBMISSIONS). Until the photos are
  chosen that is the staff switch as the booth last heard it; from then on it is the fact
  (`consentAsked` in `lib/kiosk/machine.ts`, read with `sessionAsksConsent`), so the dots never
  change under a guest who is already past that step.
- **The booth opens on "화면을 눌러 시작"** (D80): phase `attract` in `lib/kiosk/machine.ts` is the
  initial state and where every reset lands; only `OPEN` leaves it, to the welcome choices.
- **Studio props are optional pictures with a CSS stand-in** (D101): `config/studio.ts` lists
  `public/studio/` (desk, shutter knob, kraft envelope, stamp ring). A component uses a picture only
  once it has loaded (`useAssetReady`) and otherwise keeps its drawn look (`data-art="drawn"`); a
  missing file must never break a layout or a touch target. The shutter stays the screen's one
  `.booth-btn-primary`. The v2 frame picker is the Figma card grid (`.pick-card`, 898:1677), not
  postcards on the desk; nothing on the picker or the options screen sits on the binder rings
  (`--ring-safe` in `app/kiosk-figma.css`).
- **One light, top left (135°)** (D101): every cast shadow falls to +x +y: the `--shadow-*`,
  `--drop-*` tokens in `app/globals.css`, `LIGHT` in `lib/studio/ticket.ts`, `WALL_LIGHT` in
  `lib/wall/themes.ts` (= `--wall-photo-drop`). `tests/unit/studio.test.ts` reads the stylesheet
  and fails on any shadow that falls another way.
- **Booth sound is synthesised and optional** (D101): `lib/kiosk/sound.ts` (Web Audio, no files),
  unlocked by the first touch, muted per device (`ftl.boothMuted`; welcome screen and staff help).
  Nothing waits for a sound; it never touches the microphone (D72).
- **"오늘 N번째 기록" is a count, nothing more** (D101): `PhotoService.dayOrdinal` counts the photo
  rows of that photo's Asia/Seoul day up to it (`countCreatedBetween`, head-only on Supabase). The
  upload answers carry it as `dayOrdinal`; anywhere it is missing the ticket says "오늘의 기록".
  The PNG ticket is drawn on the guest's phone (`lib/studio/ticket.ts`) and sent nowhere.
- **Figma is the answer for the v2 frames and their four screens, and the match is measured**
  (「Figma 일치」, 2026-11-23, `docs/FIGMA_PARITY.md`): `e2e/figma-parity.spec.ts` (20 outputs: share of
  pixels with ΔE00 > 5 at most 1 %, photos within 1 px) and `e2e/figma-parity-screens.spec.ts`
  (768 × 1024: elements within 2 px, same type sizes, at most 2 %) compare the booth with Figma
  exports in `tests/fixtures/figma-parity/`. A change to a v2 frame, its art, a tone, or the picker
  and options screens keeps both green in Chromium and WebKit; never loosen a limit or widen a mask
  to pass. One exception is written down: Figma's picker still has seven cards, four to a row,
  and the booth has nine, five to a row in the same box (2026-11-26), so the cards area is left
  out of the pixel comparison until the Figma screen has them (`CARDS` in the screens spec; the
  card boxes are still checked against the grid they follow from). The shared header and "처음으로" are at the Figma sizes (75 tall, 26 px; wordmark 30 px;
  16 px dots) on every booth screen. The width of a space differs between browsers with the same
  font: `lib/kiosk/space.ts` measures it and `--space-fix` corrects it; never hard-code a
  `word-spacing` for one engine.
- **Skin retouch is off by default, on the device, and never reshapes a face** (「피부 보정」,
  2026-11-24, `docs/research/skin-retouch-audit.md`). It is one photo stage,
  `runPhotoStages` in `lib/kiosk/photo-stages.ts`, called once right before `composeFrame`:
  촬영 완료 → [피부 보정] → [색감] → 틀 합성. The colour look is not a photo stage: it is
  `composeFrame`'s `grade` (lib/looks, above), applied to each photo as it is drawn, so it always
  comes after the retouch. A new stage is an implementation for an id of `photo-stages.ts`, never
  a second call site. The booth's setting comes
  from the server (`SKIN_RETOUCH`, or `?retouch=` on the booth URL): `off` loads nothing at all
  and asks the guest nothing. With it on, the guest answers 끄기 / 자연스럽게 / 뽀샤시 on the
  photo-selection screen (Figma `962:1639`, `design/README.md` 「피부 보정」): a view in
  `lib/kiosk/machine.ts` (`retouch`, `SET_RETOUCH`) that starts at the booth's setting, is final
  once the photos are chosen and never carries over to the next guest. No new step: the
  progress dots do not change. The chosen answer is filled like the frame options' (a state, not
  a second action). If the model has not loaded, the choice is not offered. Every
  number is in `config/retouch.ts`; nothing in `lib/retouch` carries a tuning value. Never add a
  mesh warp (eyes, jaw, nose). Never smooth the finest band at 자연스럽게 (`fine: 0`), never
  whiten (the only brightening is 뽀샤시's `lift`, a gain with a highlight roll-off), and never
  judge skin by a fixed colour range: the colour model is each face's own (`lib/retouch/skin.ts`).
  The live preview is never retouched. Face points, masks and regions stay in the page: never
  send, store or log them (failures reach the server as a code and a count through the
  heartbeat). A photo that fails or runs over its time goes on unretouched, whole, and says so on
  the console and in the server log; never leave a photo half retouched and never let the feature
  hold up the print, the upload, the wall question or the QR. The face model is MediaPipe
  **0.10.21** with its non-SIMD build, served from `public/retouch` (never a CDN): Safari 15 has
  no WebAssembly SIMD and 1.2.2+ ship a SIMD-only binary, so do not raise the version without
  reading the audit (`tests/unit/retouch-assets.test.ts` holds the files). The filter has two
  engines doing the same 8-bit arithmetic, WebGL 1 (`gl.ts`, RGBA8 only, no extensions) and typed
  arrays (`cpu.ts`); a change to one is a change to both (`e2e/retouch.spec.ts` compares them).
  `/retouch-lab` (standalone, Safari 15) is the acceptance tool; iPad mini 4 timings are a
  person's measurement, never a desktop number.
- **The O of SHALOM holds the star** (D77) on screen (`components/brand.tsx`) and in every frame
  lockup SVG (`id="o-star"`, checked in `tests/unit/frames.test.ts`).
- **Remote Camera is a camera provider, not a second booth** (D100, `docs/REMOTE_CAMERA.md`).
  `RemoteCamera` is one more `CameraProvider`, chosen only by `?camera=remote` or
  `NEXT_PUBLIC_CAMERA_MODE=remote`; the state machine, countdown, compositing, consent and
  upload code are shared and must not fork. The phone (`/camera/remote`) takes the photo from its own
  full-resolution feed on request and sends it over the WebRTC data channel; **a failed, late or
  damaged capture is an error and a previous frame is never reused** (unique request id, one shot
  per id, length + CRC check, bounded resends). Never send a guest photo, video or id through the
  signaling routes or log them: the server only carries short-lived offers/answers and numbers
  (`CameraReport`). Pairing is a single-use 10-minute code for one kiosk, stored as a hash, exchanged
  for the `ftl_camera` cookie (own MAC key; revocation checked on every call); staff use the existing
  login (never a new password), and a booth or a phone can never issue a staff command. The camera
  page needs https and no microphone (`audio:false`). `REMOTE_CAMERA_DISABLED=1` turns every route
  into a 404. Route names must not contain "ai" or "review" (`tests/unit/ai-api.test.ts` guards that:
  hence `/link`, not `/pair`).
- **Wall rotation is decided on the hub** by the pure `rotationOrder` (`lib/wall/rotation.ts`); the
  wall only picks the first usable id. Changing rotation means keeping F1–F6
  (`docs/ARCHITECTURE.md` 1.7) green in `tests/unit/rotation.test.ts`.

## The user's words

- **밤티**: Korean slang for "tacky, unrefined, ugly, not good enough" (a meme from an old avatar-game
  screenshot; its opposite in the same slang is "장원영"). "시안이 밤티" means the design still looks
  cheap or clumsy: push the craft further, do not defend the current version.

## Layout

```
app/kiosk              booth (server gate: config + enrollment) → components/kiosk
app/kiosk/enroll       staff device enrollment
app/p/[token]          phone download page + image and video routes (server reads private bucket)
app/m/[token]          "내 사진으로 참여하기" phone page (D66): pick, turn/crop, consent, upload
app/api/mobile         booth QR session + status (kiosk cookie), phone upload (QR token only)
lib/mobile             upload QR token, server re-encoding (sharp), phone-side resize/crop
app/api/photos         upload (kiosk auth, idempotent per session), consent, session video (D72)
app/api/kiosk          enroll / signout / help (booth help mode: kiosk cookie + staff PIN, D59)
                       · app/api/operator/kiosks: list / revoke
app/api/cron/retention retention cleanup (Bearer CRON_SECRET, Vercel Cron)
app/admin              staff control panel: login, (staff)/ pages (overview, moderation,
                       sessions, photos, kiosks, settings, audit)
app/api/admin          staff APIs (staffRoute: Supabase session + allowlist + CSRF)
app/api/kiosk/heartbeat kiosk liveness (kiosk cookie)
app/wall               media wall (server gate: config + enrolled display) → components/wall
app/api/wall           wall feed (ordered eligible ids) + exposure report + image proxy (kiosk cookie)
lib/wall               wall states, pure rotation order + scheduler, server feed (emergency switches),
                       who is asking (audience.ts, D86), themes (themes.ts, D85),
                       clothesline layout + phone-photo card, watchdog, opening hours (D62),
                       dedicated wall hostname rules (host.ts, D68)
app/api/hub            cloud side of the hub's QR copy: put / reissue / delete / video (Bearer HUB_SYNC_SECRET),
                       and the phone-upload inbox: uploads/session|status|list|image|ack (D66)
app/api/photos/qr      kiosk asks again for a "QR 준비 중" photo (hub with a cloud)
lib/cloud              hub side: CloudClient (HTTP) + CloudSync (per-photo lock, queue, worker)
                       + HubInbox (phone photos down from the cloud inbox, D66)
lib/moderation         AI review (D95): policy + prompt, the copy that may leave (image.ts), provider
                       adapters, the service (queue → verdict, fail closed), server wiring + sweeps
app/api/photos/review  the booth asks how its photo's review is going (kiosk cookie; one word)
app/api/cron/ai-review work through the AI review queue (Bearer CRON_SECRET; optional)
lib/ops                moderation rules, enrollment codes, kiosk health, staff read models,
                       hub retention (D47/D58: rules in hub-retention.ts, timer in -server.ts),
                       USB backup + disk status (D60: backup.ts, backup-server.ts), event close (D64)
lib/staff-auth         staff sessions: shared password (shared.ts, D84), Supabase Auth (cloud) or
                       PIN + signed cookie (hub), setup code
proxy.ts               refreshes staff sessions for /admin pages (no authorization here)
components/admin       admin UI (cards, dialogs, emergency switches, kiosk/staff managers)
components/brand.tsx   the STUDIO SHALOM lockup and one-line wordmark as text (styles in app/globals.css)
lib/camera             CameraProvider: BrowserCamera, MockCamera, RemoteCamera (D100), shared grabFrame
lib/remote-camera      Remote Camera: protocol, shutter (host/client), chunked transfer, signaling client,
                       iPhone logic (phone.ts), pairing code + cookie, mailbox stores (memory, Supabase)
app/camera/remote      the iPhone's page · app/api/camera + app/api/kiosk/camera (signaling, status, link)
                       · app/api/admin/remote-camera (staff: pair, commands, revoke) · /admin/remote-camera
lib/compositor         FrameDefinition types, coverCrop, composeFrame
lib/retouch            skin retouch: face finder (MediaPipe, lazy), face geometry + mask, each face's
                       skin colour model, per-face plan, WebGL 1 and CPU engines, pipeline (budgets,
                       failures), stats for the tests and the lab
lib/kiosk/photo-stages.ts  the one hook between shooting and the frame (skin retouch; the colour look is composeFrame's grade)
config/retouch.ts      every skin-retouch number: levels, thresholds, budgets, the flag
retouch-lab/           /retouch-lab page (own Vite bundle for Safari 15) · app/retouch-lab (route, gated)
public/retouch         self-hosted face model + runtime (NOTICE.md), lab sample photos (sources, licences)
lib/looks              colour looks (flag, off by default): look arithmetic (engine.ts), .cube + LUT
                       sampling (cube.ts), WebGL1 shader + renderer, reference arithmetic for tests,
                       frame → look mapping + flag (config.ts), booth loader (booth.ts)
looks-sheet            /looks comparison sheet: stand-alone Safari 15 bundle (vite), served by
                       app/looks/route.ts; samples in public/looks/samples (synthetic)
lib/kiosk              pure state machine, help-mode reducer, session helpers, upload/consent client,
                       booth copy in Korean and English (copy.ts, D78),
                       session video recorder (injected MediaRecorder, D72)
lib/video              video types, magic-byte check, byte ranges (shared by booth and server)
lib/offline            IndexedDB stores + UploadQueue and ConsentQueue (retry, dedupe, reload-safe)
lib/kiosk-auth         signed kiosk session cookie, enrollment, verification
lib/server             env validation, logging, rate limits, request helpers
lib/storage            PhotoService (all rules) + backends: memory, local files, Supabase
supabase/migrations    schema, RLS, private bucket
scripts                hub-start.mjs (launcher), hub-restore.mjs, event-check.mjs (read-only deletion
                       check), staff-add.mjs (plain Node, unit tested)
ops                    desktop-icon wrappers: start-hub / restore-backup / event-check (.bat/.command),
                       start-wall
config/moderation.ts   AI review knobs, category codes and their staff Korean (D95)
config/                kiosk knobs, frame definitions, pose guide sequence (poses.ts, D71),
                       wall themes (wall-themes.ts, D85), looks (looks/index.ts, frame-looks.json)
design/                Figma source link, Figma -> code mapping (README), page previews
tests/unit             Vitest (jsdom/node; FakeCanvas; fake-indexeddb)
tests/integration      real Supabase (npm run test:supabase)
e2e/                   Playwright (kiosk auth on; E2E_STORE=supabase optional; SCREENSHOTS=1)
measure/               Phase 4 measurements: seeded hub load + long wall run (playwright.measure.config.ts)
```

## Working rules

- Keep kiosk rules in `lib/kiosk/machine.ts` (pure reducer) and test them there. Components only
  run effects and dispatch.
- Anything touching canvas takes a `CanvasFactory` so it is testable with `tests/helpers/fake-canvas.ts`.
- Kiosk copy: short Korean, large touch targets: `.booth-btn-primary`/`-secondary` are ≥ 80 px tall
  (64–80 px only when the booth is under 760 px tall), smaller controls ≥ 52 px (D88). Exception:
  the v2 picker and options screens follow Figma (bottom bar 76 px at 768 × 1024, option buttons
  60 px, scaled with the screen, never under 48 px).
- Storage rules live in `lib/storage/photo-service.ts` (+ `lib/ops`); backends stay dumb. New
  backend behaviour must pass `tests/helpers/photo-contract.ts` and `tests/helpers/ops-contract.ts`.
- Staff features run on the hub (`FTL_ROLE=hub PHOTO_STORE=local`; /admin opens with
  `KIOSK_ENROLL_SECRET`, or with a PIN at `/admin/login?staff=1`, whose setup code is
  printed in the server console) or on Supabase (`npx supabase start`, codes in Mailpit
  `http://127.0.0.1:54324`). `npm run test:e2e` runs as the hub; `E2E_STORE=supabase` runs the
  cloud admin specs (see docs/ADMIN.md).
- Any change to AI review must keep `tests/helpers/ai-contract.ts` green on every backend
  (memory, local, and the SQL functions: `FTL_TEST_PG_URL=… npx vitest run tests/integration/ai-review-sql.test.ts`).
  Never send a guest's photo to a provider in development; the evaluation set is synthetic or
  licensed pictures only (`docs/AI_MODERATION.md` 2.3).
- Before committing: `npm run check`. Before claiming a flow works: `npm run test:e2e`. Touching
  Supabase code or migrations: also `npm run test:supabase`.
- Never claim the real-phone cellular test passed unless a human did it (see DEPLOYMENT).
- Develop without a camera via `/kiosk?camera=mock`.
- Never commit `.env*.local`, `.data/`, or guest photos.
- Don't call anything "production ready" without real-device verification (see ROADMAP).
