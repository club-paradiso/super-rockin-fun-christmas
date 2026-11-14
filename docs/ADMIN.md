# Staff guide — `/admin`

The control panel for Christmas Village staff. It works on a desktop, tablet or phone. Every
action is checked on the server and recorded in **기록** (audit).

## Logging in

### The usual way: the shared password (D84)

1. Open `/admin` (cloud: `https://<site>/admin`; hub: `http://<hub address>:3000/admin`).
2. Type the **kiosk enrollment password** (`KIOSK_ENROLL_SECRET`, the one used to enroll a booth)
   → **관리자 화면 열기**. **보기** shows what you typed.

That is all: no email, no code. You are signed in as **공용 관리자** for 12 hours, on that browser
only. **로그아웃** (top right) ends it. Eight wrong passwords lock that device's address for 15
minutes.

- Everyone who uses the password is the same 공용 관리자 in **기록**: the log shows what was done
  and when, not which person did it.
- A booth enrolled with the same password is **not** signed in to /admin, and signing in to /admin
  does not enroll a booth.
- If the password is shorter than 12 characters, or not set, this login is off and the page says
  so. Use a personal login below.
- If the password leaks: change `KIOSK_ENROLL_SECRET` and redeploy (hub: restart). Every
  administrator session ends; booths that are already enrolled keep working.

The personal logins below still work, from **이름과 PIN으로 로그인** / **스태프 이메일 코드로
로그인** under the password field (`/admin/login?staff=1`). Use one when the log should show who
did something. On the hub a personal PIN is also what opens the booth's staff menu (help mode).

### Personal login on the venue hub (`FTL_ROLE=hub`)

1. On a phone connected to the event router, open `http://<hub address>:3000/admin/login?staff=1`.
2. Tap your name, type your 6-digit PIN on the keypad → **로그인**.

Five wrong PINs lock that name for 15 minutes. **First time on a new hub:** the black hub window
on the booth laptop shows a one-time **설정 코드**. Open `/admin/login?staff=1`, type that code, your name
and a new PIN → **첫 스태프 만들기**. After that the code no longer works.

**Adding staff:** **설정 → 스태프** → name + PIN → **스태프 추가**. Tell the person their PIN in
person. **PIN 바꾸기** sets a new PIN and logs that person out everywhere. **비활성화** cuts
someone off on their very next click. No email or phone number is stored.

### Personal login on the cloud deployment (email codes)

1. Open `https://<site>/admin/login?staff=1` → **스태프 로그인**.
2. Enter your email → **로그인 코드 받기**.
3. Check your email for a 6-digit code (valid 10 minutes) → enter it → **로그인**.

There is no personal password and no sign-up. Only people on the staff list receive a code, and the
screen looks identical for anyone else, so it doesn't reveal who is staff.

**Adding staff:** **설정 → 스태프** → email + name → **스태프 추가**. That person can log in
straight away. **비활성화** cuts someone off on their very next click, and you cannot deactivate
yourself. The very first staff member is created once from a terminal:
`npm run staff:add -- you@example.org "이름"`.

## Menu

| Tab           | Use it for                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **개요**      | Emergency switches, waiting-for-review count, kiosk status, kiosk upload backlog, stored photos, last cleanup                    |
| **검수**      | The moderation queue: photos whose guest said **yes** to the media wall, oldest first. **승인** / **반려**                       |
| **최근 세션** | Helping a guest whose QR didn't appear or got lost (last 1–24 h only)                                                            |
| **사진**      | Library with filters (status, time window, kiosk, session code) and every action                                                 |
| **키오스크**  | Kiosk status, rename, **등록 해제** (revoke), one-time enrollment codes                                                          |
| **설정**      | Emergency switches, wall hours, **미디어월 배경**, **미디어월 사진 속도**, **공개 미디어월**, booth start screen, the staff list |
| **기록**      | Append-only history of every change (who, what, when)                                                                            |

## Moderation rules

Only photos whose guest agreed to the media wall can ever be approved. The server enforces
this, and so does the database.

| From                | Action      | To                                              |
| ------------------- | ----------- | ----------------------------------------------- |
| 검수 대기 (PENDING) | 승인        | 승인됨 (APPROVED) — eligible for the wall       |
| 검수 대기           | 반려        | 반려됨 (REJECTED) — guest can still download it |
| 승인됨              | 숨기기      | 숨김 (HIDDEN)                                   |
| 숨김                | 다시 보이기 | 승인됨                                          |
| 반려됨              | 다시 검수   | 검수 대기 (undo a mistaken rejection)           |
| any                 | 삭제        | 삭제됨 (DELETED) — **permanent**                |

If two staff act on the same photo at once, the second one gets "다른 스태프가 먼저 처리했어요" and
nothing is overwritten.

## 지금 띄우기 (show now)

When a guest asks "when will my photo be on the wall?", find it in **사진** (or **최근 세션**) and
press **지금 띄우기**. It appears on the wall within about 10 seconds, making room by ending the
turn of the photo that has been up longest. Only approved photos with wall consent can be shown.
Every request is recorded in **기록**. The wall otherwise rotates fairly on its own: new photos
first, then the ones shown least often.

## Deleting a photo

**삭제** opens a confirmation dialog, then:

- the image file and its preview are removed from storage immediately;
- the guest's QR link stops working (`/p/…` shows "사진을 찾을 수 없어요");
- the photo can never appear on the media wall;
- the deletion is recorded in 기록.

There is no "restore deleted photo", because the image no longer exists. Deleting twice is
harmless.

## Show the QR again (QR 다시 보여주기)

For a guest whose QR never appeared, or who lost it:

1. **최근 세션** → find the photo by time and kiosk, or type the **session code**. The kiosk shows
   it small under the QR, e.g. `세션 3f2a9c1d`.
2. **QR 다시 보여주기** → confirm. The dialog warns that the old QR will stop working.
3. Let the guest scan the new QR on your screen.

This creates a **new** link for the same photo. The previous QR or link stops working at once.
Only the explicit button does this; just viewing a session never changes anything. The new link
lasts the normal link lifetime, but never past the photo's retention date.

## Kiosks

- **Status:**
  - 온라인 (online) = a heartbeat within 2 minutes.
  - 응답 지연 (delayed) = within 15 minutes.
  - 오프라인 (offline) = older than that, or never.
  - 등록 해제됨 (revoked) = revoked.
- **전송 대기 N건** = photos saved on that kiosk that haven't reached the server yet (it was offline).
- **Enroll a new kiosk:**
  1. **새 키오스크 등록** → name → **일회용 등록 코드 만들기**.
  2. On the new device open `/kiosk/enroll` and type the code.
     The code works **once**, for **15 minutes**, and is shown only once.
- **등록 해제 (revoke)** blocks that device immediately: no uploads, no heartbeat. To use it again,
  enroll it with a new code.

## Emergency switches (개요 / 설정)

| Switch                                          | Effect now                                                                                                                                      | Who reads it    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **미디어월 게시 신청 중지** (PAUSE SUBMISSIONS) | Kiosks stop asking "미디어월에도 보여줄까요?" and the server refuses new "yes" answers. **Taking photos, QR codes and downloads keep working.** | kiosks + server |
| **미디어월 일시정지** (PAUSE WALL)              | The wall takes every photo down within 10 s and shows only the village. Turning it off brings approved photos back                              | `/wall` feed    |
| **대기 화면 표시** (SHOW HOLDING SCREEN)        | The wall shows a holding message and receives no photos. Wins over PAUSE WALL                                                                   | `/wall` feed    |

While any switch is on, a red banner appears on every admin page.

## 미디어월 사진 속도 (설정, D92)

- **한 장이 떠 있는 시간**: 5–120 s (default 14 s). Shorter turns photos over faster.
- **반감기**: off by default (every photo gets the same number of turns). Set to, say, 1시간, a
  photo taken an hour ago comes up half as often as a new one, two hours ago a quarter. Old
  photos never disappear because of it; to take a photo off the wall, hide or delete it.
- 속도 저장 applies within one poll (about 5 s) on every wall, venue and public. 기본값으로
  되돌리기 goes back to 14 s and off. Changing the background does not change the pace.

## 미디어월 배경 (설정, D85)

Nine backgrounds: eight STUDIO SHALOM scenes and the old night scene (marked 이전 디자인).

- Tap a card → **배경 저장**. Every wall changes within about 5 seconds, with a soft fade. Nothing
  else changes: photos, review and the booth carry on.
- **배경을 자동으로 바꿔요**: tick **돌아가며 보여 주기** on two or more cards, choose the interval
  (5–120 minutes) → **배경 저장**. All walls change at the same moment.
- **기본 배경으로 되돌리기** goes back to 평화의 벽 with rotation off, in one tap.
- "지금 화면" shows what is on the wall right now.

## 공개 미디어월 (설정, D86)

The wall address opens for anyone, with no code and no enrollment. This switch decides whether
such a screen is sent **photos**.

| Switch             | A screen that just opens the wall address             | A screen enrolled as a display (키오스크 → 등록 코드) |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| **꺼짐** (default) | the background only, no photos                        | every approved photo                                  |
| **켜짐**           | approved photos whose guest agreed to the public wall | every approved photo                                  |

- Turning it **on** asks for confirmation. Within a minute the booth's consent screen gains the
  line "미디어월은 행사장 화면과 온라인 주소에서 함께 보여요." and the phone page shows it too.
  Only photos agreed to **after** that are public.
- Photos agreed to before, or while it was off, were agreed to for the venue screen only. They
  never appear on a public screen, whatever you do later; they still appear on an enrolled
  display. The card shows both counts.
- Turning it **off** stops photos on public screens within about 5 seconds.
- **To show every approved photo at the venue**, enroll that screen once
  (`/kiosk/enroll?next=wall` with a 등록 코드): it then gets the full feed and appears under
  **키오스크**. Or keep the public wall on from before the first guest, so every photo is public.
- The emergency switches and the wall hours apply to every screen, public or enrolled.

## Privacy

This is event moderation, not surveillance:

- no face recognition, search by person, guest profiles or contact details;
- recent sessions are limited to recent hours;
- photos are deleted automatically after the retention period.

## Local development: logging in without real email

The local Supabase stack catches every email in **Mailpit**: open `http://127.0.0.1:54324`, click
the newest "FOLLOW THE LIGHTS 스태프 로그인 코드" message, and copy the 6-digit code.

```bash
npx supabase start            # once (Docker); applies migrations, starts Auth + Mailpit
eval "$(npx supabase status -o env | sed 's/^/export SB_/')"
SUPABASE_URL=$SB_API_URL SUPABASE_SERVICE_ROLE_KEY=$SB_SERVICE_ROLE_KEY \
  npm run staff:add -- me@example.org "나"
# .env.local: PHOTO_STORE=supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
npm run dev  →  http://localhost:3000/admin
```

Tests do the same thing automatically: `e2e/staff-helpers.ts` reads the code from the Mailpit
API, and the integration tests use the Auth admin API.
