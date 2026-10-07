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
4. Copy the **Project URL** and the **service_role** key (Settings → API). Do not use the anon
   key anywhere.

## 2. Vercel

1. Import the GitHub repo into Vercel. The framework preset is Next.js and needs no build
   overrides.
2. Environment variables (Production, and Preview if you test previews). Use
   `openssl rand -base64 48` for the secrets:

| name                        | value                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`           | `https://<your-domain-or-project>.vercel.app` — the exact origin phones will open |
| `PHOTO_STORE`               | `supabase`                                                                        |
| `SUPABASE_URL`              | `https://<ref>.supabase.co`                                                       |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**Sensitive**)                                                  |
| `KIOSK_SESSION_SECRET`      | ≥ 32 random chars (**Sensitive**)                                                 |
| `KIOSK_ENROLL_SECRET`       | ≥ 20 random chars, different from the above (**Sensitive**)                       |
| `CRON_SECRET`               | ≥ 32 random chars (**Sensitive**). Vercel Cron sends it automatically             |
| `PHOTO_LINK_TTL_HOURS`      | `72` (optional)                                                                   |
| `PHOTO_RETENTION_DAYS`      | `30` (optional)                                                                   |
| `NEXT_PUBLIC_CAMERA_MODE`   | `browser`                                                                         |

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

## 3. Enroll the kiosk

On the kiosk device's browser: open `https://<origin>/kiosk/enroll`, enter a device name and
`KIOSK_ENROLL_SECRET`, then press **이 기기 등록**. Then open `/kiosk`, put it in full screen, and
allow the camera.

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

## Self-hosted alternative (Path A on one PC)

`PHOTO_STORE=local` stores photos on the kiosk PC's disk. Phones can only reach it if that PC is
published at a public https origin (for example a tunnel). The server refuses private-network
`PUBLIC_BASE_URL` values in production. Vercel + Supabase is the supported path.
