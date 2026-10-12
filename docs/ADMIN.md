# Staff guide — `/admin`

The control panel for Christmas Village staff. It works on a desktop, tablet or phone. Every
action is checked on the server and recorded in **기록** (audit).

## Logging in

1. Open `https://<site>/admin` → **스태프 로그인**.
2. Enter your email → **로그인 코드 받기**.
3. Check your email for a 6-digit code (valid 10 minutes) → enter it → **로그인**.

There are no passwords and no sign-up. Only people on the staff list receive a code, and the
screen looks identical for anyone else, so it doesn't reveal who is staff.

**Adding staff:** **설정 → 스태프** → email + name → **스태프 추가**. That person can log in
straight away. **비활성화** cuts someone off on their very next click, and you cannot deactivate
yourself. The very first staff member is created once from a terminal:
`npm run staff:add -- you@example.org "이름"`.

## Menu

| Tab           | Use it for                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| **개요**      | Emergency switches, waiting-for-review count, kiosk status, kiosk upload backlog, stored photos, last cleanup |
| **검수**      | The moderation queue: photos whose guest said **yes** to the media wall, oldest first. **승인** / **반려**    |
| **최근 세션** | Helping a guest whose QR didn't appear or got lost (last 1–24 h only)                                         |
| **사진**      | Library with filters (status, time window, kiosk, session code) and every action                              |
| **키오스크**  | Kiosk status, rename, **등록 해제** (revoke), one-time enrollment codes                                       |
| **설정**      | Emergency switches and the staff list                                                                         |
| **기록**      | Append-only history of every change (who, what, when)                                                         |

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

| Switch                                     | Effect now                                                                                                                                      | Who reads it    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **미디어월 참여 중지** (PAUSE SUBMISSIONS) | Kiosks stop asking "미디어월에도 보여줄까요?" and the server refuses new "yes" answers. **Taking photos, QR codes and downloads keep working.** | kiosks + server |
| **미디어월 일시정지** (PAUSE WALL)         | The wall takes every photo down within 10 s and shows only the village. Turning it off brings approved photos back                              | `/wall` feed    |
| **대기 화면 표시** (SHOW HOLDING SCREEN)   | The wall shows a holding message and receives no photos. Wins over PAUSE WALL                                                                   | `/wall` feed    |

While any switch is on, a red banner appears on every admin page.

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
