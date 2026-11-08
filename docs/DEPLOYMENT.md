# Deployment (Vercel + Supabase)

Reference deployment: Next.js on Vercel, Supabase Postgres plus a private Storage bucket. The
Next.js server is the only thing that talks to Supabase.

## 1. Supabase

1. Create a project (region `ap-northeast-2` / Seoul is closest to the venue).
2. Apply the migrations from your machine:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
3. Check in the dashboard: Storage → `photos` is **not public**; Table editor → `photos` and
   `kiosks` show "RLS enabled".
4. Copy the **Project URL**, the **service_role** key and the **anon** key (Settings → API).
   All three go only into server-side env vars.
5. Auth settings (Authentication → Providers / Templates), to match `supabase/config.toml`:
   - **disable new user signups**;
   - Email provider on, OTP length 6, expiry 600 s;
   - "Magic Link" email template: subject `FOLLOW THE LIGHTS 스태프 로그인 코드`, body from
     `supabase/templates/staff-login.html` (it must contain `{{ .Token }}`);
   - configure **custom SMTP** first. Supabase's built-in mailer is rate-limited, only mails
     members of the Supabase organization, and the dashboard will not let you edit the email
     templates until custom SMTP is on. Without the template above the email carries a link instead
     of the 6-digit code, and staff cannot log in. A Gmail account with an app password works
     (`smtp.gmail.com`, port 465).
     (`npx supabase config push` can apply the `[auth]` section from `config.toml`.)
6. First staff member: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run staff:add -- lead@example.org "책임자"`.

## 2. Vercel

1. Import the GitHub repo into Vercel. The framework preset is Next.js and needs no build
   overrides.
2. Environment variables (Production, and Preview if you test previews). Use
   `openssl rand -base64 48` for the secrets:

| name                        | value                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`           | `https://<your-domain-or-project>.vercel.app` — the exact origin phones will open   |
| `PHOTO_STORE`               | `supabase`                                                                          |
| `SUPABASE_URL`              | `https://<ref>.supabase.co`                                                         |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**Sensitive**)                                                    |
| `KIOSK_SESSION_SECRET`      | ≥ 32 random chars (**Sensitive**)                                                   |
| `KIOSK_ENROLL_SECRET`       | operator-chosen nonblank password, different from session secret (**Sensitive**)    |
| `CRON_SECRET`               | ≥ 32 random chars (**Sensitive**). Vercel Cron sends it automatically               |
| `HUB_SYNC_SECRET`           | ≥ 32 random chars, different from all of the above (**Sensitive**). Only with a hub |
| `PHOTO_LINK_TTL_HOURS`      | `72` (optional)                                                                     |
| `PHOTO_RETENTION_DAYS`      | `30` (optional)                                                                     |
| `NEXT_PUBLIC_CAMERA_MODE`   | `browser`                                                                           |

Preview deployments get a different URL per deploy. Set `PUBLIC_BASE_URL` (Preview scope) to
the preview URL you are testing, or use a stable preview alias. Production refuses to start
serving uploads with a missing, `http://` or private-network `PUBLIC_BASE_URL`. 3. Deploy. In the runtime logs, the first request shows `{"event":"config_ok",…}`, or
`config_invalid` with the exact problem. 4. Retention: `vercel.json` schedules `GET /api/cron/retention` daily at 18:17 UTC (03:17 KST).
Check Settings → Cron Jobs. To run it manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<origin>/api/cron/retention
```

Limits to know: Vercel functions accept ≤ 4.5 MB request bodies, which is why the upload cap is
4 MB (a four-cut JPEG is about 0.3–1.5 MB). On the Hobby plan, cron runs at most once a day.

## 3. Enroll the kiosk (operator password first)

The default kiosk setup supports two enrollment methods. **An operator-selected shared password is
the primary path when configured; one-time staff-issued codes remain the fallback.** This is kiosk
device enrollment only, **not** staff authentication or permission to approve photos for the wall.

1. In Vercel → `follow-the-lights` → Settings → Environment Variables, create
   `KIOSK_ENROLL_SECRET` for **Production** as an encrypted/sensitive server-side value.
   The operator chooses the value; **there is no minimum length enforced by the server**.
   Prefer a unique, hard-to-guess passphrase and do not reuse a staff PIN, event password,
   or `KIOSK_SESSION_SECRET`. Short numeric codes are easier to guess over the internet.
   Do not put it in source code, QR codes, screenshots, or public documentation.
2. Redeploy **Production** after saving the environment variable. Merely editing the variable
   does not retroactively update existing deployments.
3. On the iPad in Safari, open `https://follow-the-lights.vercel.app/kiosk/enroll`,
   enter a descriptive **기기 이름** and **등록 비밀번호**, then select **비밀번호로 등록**.
   A successful registration issues a Secure, HttpOnly, SameSite=Lax session cookie and
   forwards the device to `/kiosk`. The kiosk row is persisted and remains revocable.
4. For a wall display use `/kiosk/enroll?next=wall` on the wall browser.
5. One-time fallback: staff can still open `/admin` → 키오스크 → generate a single-use
   enrollment code (valid 15 minutes); type it in the separate code form.

The password is server-validated, rate-limited, and never sent to public JavaScript.
**Changing the shared password prevents new enrollments with the old password but does not
revoke previously enrolled devices.** Revoke compromised devices individually in admin.
The production setting is intentionally absent until an operator explicitly chooses it;
without it, only one-time-code registration is offered. This does not bypass SMTP/OTP
requirements for staff login, or certify physical camera and QR behavior.

## 4. REAL-PHONE CELLULAR TEST (the Phase 2 gate)

Playwright cannot prove this. A person with a phone must do it:

1. On the kiosk, take a four-cut photo and press **휴대폰으로 받기**. The QR appears.
2. On a phone, **turn Wi-Fi OFF** so it uses cellular data.
3. Scan the QR with the default camera app.
4. `/p/<token>` opens on the public domain (not localhost, not a 192.168 address).
5. The image loads.
6. **사진 저장하기**:
   - iPhone Safari: the share sheet opens, then **이미지 저장** puts it in Photos. Also try
     long-press → 사진 앱에 저장.
   - Android Chrome: the share sheet or a download, saved to Gallery or Downloads.
7. Repeat with a QR scan inside KakaoTalk or the Naver app (in-app browsers), since many guests
   will use those.
8. Answer **아니요** on the kiosk and confirm the phone link still works. Answer **네** on another
   session and confirm the row shows `moderation_status = PENDING`.

Record the device models, OS versions and results in the PR. Until this is done, the status is
`REAL_PHONE_CELLULAR_TEST: NOT VERIFIED`.

## Connecting the on-site hub (QR copy, D57)

The hub (`FTL_ROLE=hub` on the booth laptop) sends each photo's copy to this deployment and shows
the link it gets back. Set the same `HUB_SYNC_SECRET` on both sides, and on the hub:

```bash
CLOUD_BASE_URL=https://<your-domain-or-project>.vercel.app   # origin only
HUB_SYNC_SECRET=<same value as on Vercel>
CLOUD_SYNC_TIMEOUT_MS=8000                                    # optional
```

The hub console prints `config_ok` with `cloud: <origin>` at start. A wrong secret shows on the
hub overview as "QR 대기 N건 · 마지막 오류: cloud 401"; the photos wait on the hub and go out once
the secret is fixed. With a hub, the cloud keeps only copies, so its `PHOTO_RETENTION_DAYS` can be
as short as the link lifetime (the plan proposes a 24 h link; the final values wait for the
church's privacy decision, see `docs/STATUS.md`).

`HUB_TO_CLOUD_OVER_REAL_INTERNET: NOT VERIFIED` (tested with two local servers only).

## Self-hosted alternative (Path A on one PC)

`PHOTO_STORE=local` stores photos on the kiosk PC's disk. Phones can only reach it if that PC is
published at a public https origin (for example a tunnel). The server refuses private-network
`PUBLIC_BASE_URL` values in production. Vercel + Supabase is the supported path.

## 5. REAL STAFF DEVICE TEST (the Phase 3 gate)

Before the event, a person must do this on the actual staff phone or tablet:

- log in with an emailed code;
- approve, reject and delete a photo from a real kiosk;
- use QR 다시 보여주기 and scan the new QR on a phone (old QR must fail);
- toggle PAUSE SUBMISSIONS and confirm the kiosk skips the wall question while QR still works;
- revoke and re-enroll a kiosk with a one-time code.

Until then: `REAL_STAFF_DEVICE_TEST: NOT VERIFIED`.

## 6. Enroll the wall display

1. In `/admin → 키오스크`, create a one-time code labelled e.g. `미디어월`.
2. On the wall PC or TV browser, open `https://<PUBLIC_BASE_URL>/kiosk/enroll?next=wall` and type
   the code. The browser goes to `/wall`.
3. Make the browser full screen and turn off sleep and screen savers. The wall shows up in the
   kiosk list and reports in every 45 s.

## 7. REAL WALL DISPLAY TEST (the Phase 4 gate)

Before the event, a person must do this on the actual wall screen at the venue:

- with nothing approved, the wall shows the empty village;
- take a photo, answer **네**, approve it in /admin: it appears within about 20 s;
- hide it: it leaves within 10 s; unhide: it comes back; delete another: it never appears again;
- toggle PAUSE WALL (photos leave, village stays) and SHOW HOLDING SCREEN (holding message);
- pull the network cable or turn Wi-Fi off: the wall keeps going for about 2 minutes, then shows
  only the village; it recovers on its own when the network returns;
- check readability and brightness from where guests stand, and leave it running for an hour.

Until then: `REAL_WALL_DISPLAY_TEST: NOT VERIFIED`.

## 8. Dedicated media-wall address (D68) — needs approval, not done

Same deployment, a second hostname (`docs/MEDIA_WALL_ARCHITECTURE.md`). Steps for the person who
approves production changes:

1. Vercel → project `follow-the-lights` → Settings → Domains → add `follow-the-lights-wall.vercel.app`
   (or another free `*.vercel.app` name if that one is taken; no cost).
2. Environment Variables → `WALL_HOSTS=follow-the-lights-wall.vercel.app` (Production and Preview).
   `PUBLIC_BASE_URL` stays the booth address: wall-host pages for staff and guests redirect there.
3. Redeploy (`WALL_HOSTS` is read at build time).
4. Check: `/` on the wall address shows the wall enrollment notice; `/admin` there redirects to the
   booth address. Enroll the wall display at `https://<wall address>/kiosk/enroll?next=wall`.

Rollback: remove `WALL_HOSTS` and redeploy (the domain can stay; it then serves the normal app).

## 9. Phone uploads (D66)

No new env vars. The phone page lives on `PUBLIC_BASE_URL` (`/m/…`). With a hub, the cloud needs
`HUB_SYNC_SECRET` (already required for the QR copy) and the hub pulls phone photos every 15 s.
Schema: migration `20261108090000_v2_kiosk_mode.sql` (easy-mode default only; phone photos need no
schema change). Apply it **before** deploying this code. It adds the 9-argument settings function
and keeps the 8-argument one, so the code still running keeps working (emergency switches
included) until the new code is live. After the 2.0 deploy, a follow-up migration drops the
8-argument function (not written yet on purpose: `supabase db push` before the deploy would break
the running code).

## Preview deployment (2026-10-14)

A preview for real-device testing, without a hub. Checklist: `docs/PREVIEW_DEVICE_TEST.md`.

- Origin: `https://follow-the-lights.vercel.app` (Vercel team `club-paradiso`, project
  `follow-the-lights`, functions in `icn1` Seoul). Standard Deployment Protection leaves this
  production domain public, so phones open it without a Vercel login.
- Code: the project is connected to this GitHub repository with production branch `main`, so every
  merge to `main` redeploys the preview. The first build (`main` at `5390ff0`) was uploaded with
  the Vercel CLI before the repository was connected. Other branches get Vercel preview
  deployments, which have no env vars and sit behind Vercel login: use them only to check that
  the build passes.
- Supabase: project `follow-the-lights-preview` (ref `wzjjblrtrrwwczzmsmvm`, Seoul, free plan; a
  free project pauses after a week without use). The three migrations were applied through the
  Supabase MCP connector, so the dashboard's migration history shows the same names with
  different version numbers. They are re-runnable, so a later `supabase db push` is harmless.
- Env vars (Production): `PUBLIC_BASE_URL`, `PHOTO_STORE`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `KIOSK_SESSION_SECRET`, `CRON_SECRET`,
  `NEXT_PUBLIC_CAMERA_MODE`, `PHOTO_LINK_TTL_HOURS=72`, `PHOTO_RETENTION_DAYS=30`,
  `KIOSK_ENROLL_SECRET` (operator-selected). Not set on
  purpose: `HUB_SYNC_SECRET` (no hub yet),
  `KIOSK_AUTH_DISABLED`.
