# Operations (event day)

## Before doors open

- [ ] `/kiosk` shows the welcome screen, not "등록되지 않았어요" or "서버 설정 오류".
- [ ] One full test session, scanned on a phone **on cellular data**.
- [ ] No "전송 대기" badge in the top-right corner.
- [ ] Kiosk browser in full screen; screen sleep disabled; camera permission granted for the site.

## Kiosk badges (top-right, for staff)

| badge            | meaning                                                                    | action                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `전송 대기 N건`  | N finished photos are saved on this device but have not reached the server | Check the venue internet connection. They upload automatically when it returns, even after a reload. Don't clear the browser data. |
| `기기 등록 필요` | the server rejected this device (expired or revoked)                       | Re-enroll at `/kiosk/enroll`. The queued photos then upload.                                                                       |
| `오프라인`       | the browser reports no network                                             | as above                                                                                                                           |
| `임시 저장소`    | IndexedDB is unavailable (private browsing?)                               | Use a normal browser window, or queued photos will not survive a reload                                                            |

If a guest's photo is stuck in the queue, they won't get a QR on the spot (the kiosk never shows a
fake QR). The photo is kept and uploaded later. Showing it again to that guest is a Phase 3 admin
feature.

## Revoke a lost device

```bash
curl -H "Authorization: Bearer $KIOSK_ENROLL_SECRET" https://<origin>/api/operator/kiosks
curl -X POST -H "Authorization: Bearer $KIOSK_ENROLL_SECRET" -H 'content-type: application/json' \
  -d '{"action":"revoke","kioskId":"<id>"}' https://<origin>/api/operator/kiosks
```

To revoke every kiosk at once, rotate `KIOSK_SESSION_SECRET` in Vercel and redeploy.

## Logs (Vercel → Logs; one JSON line per event)

| event                                                | meaning                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `upload_ok`                                          | photo stored (`duplicate`, `queueDepth`, `bytes`, `kioskId`, `photoId`) |
| `upload_storage_failed`                              | Supabase write failed. The kiosk keeps the photo and retries            |
| `kiosk_auth_rejected`                                | upload or consent without a valid kiosk session (`reason`)              |
| `kiosk_enroll_denied` / `_rate_limited`              | wrong enrollment secret / too many tries                                |
| `guest_link_unavailable` / `guest_image_unavailable` | someone opened an expired or deleted link                               |
| `wall_consent`                                       | consent recorded (`moderation`)                                         |
| `retention_cleanup`                                  | `examined` / `deleted` / `failed`                                       |
| `config_invalid`                                     | deployment misconfigured. Fix the env vars                              |

Logs never contain raw tokens, image bytes or secrets.

## After the event

- Rotate `KIOSK_ENROLL_SECRET` and `KIOSK_SESSION_SECRET`.
- Photos disappear automatically after `PHOTO_RETENTION_DAYS`.
