# Security model (Phase 2–4)

Scope: a church Christmas event with one to a few kiosks, guest phones on any network, and a few
volunteer staff. The goal is proportionate protection for guests' photos, not enterprise
security.

## Assets

1. **Guest photos.** These are images of people, including children. They are the main asset.
2. **Upload capability.** Anyone who can upload can fill storage, or later put content in the
   wall moderation queue.
3. **Server secrets:** Supabase service-role key, kiosk session secret, enrollment secret, cron
   secret.

## Threats and what stops them

| Threat                                                           | Mitigation                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone guesses photo links                                      | 192-bit random tokens (`crypto.randomBytes(24)`). Guessing is infeasible. Per-IP rate limit on guest routes.                                                                                                                                                               |
| A leaked DB dump or file listing reveals links                   | Only `sha256(token)` is stored. Object paths are random UUIDs, not tokens.                                                                                                                                                                                                 |
| A guest learns the storage location or forms a direct bucket URL | The bucket is **private** (`public = false`, no storage policies for anon/authenticated). Bytes go through `/p/[token]/image` on the server. No signed URLs or paths are ever sent to clients (tests assert this).                                                         |
| Probing which tokens existed                                     | Unknown, malformed, expired and deleted all return the same 404 page or response.                                                                                                                                                                                          |
| Random internet clients upload                                   | `/api/photos` requires an enrolled-kiosk session (HttpOnly cookie, HMAC-signed, expiring, checked against a non-revoked `kiosks` row).                                                                                                                                     |
| Secrets shipped in frontend JS                                   | No secret has a `NEXT_PUBLIC_` name. The enrollment secret is typed by staff into a form and compared server-side. E2E checks the served JS bundles for secrets.                                                                                                           |
| CSRF using the kiosk's cookie                                    | `SameSite=Lax` (cross-site POST/fetch never carry it), plus an `Origin` check on every state-changing route. Uploads also need a non-simple content type and custom headers, which trigger a CORS preflight that is never approved.                                        |
| Lost or stolen kiosk tablet                                      | Revoke it: `POST /api/operator/kiosks {"action":"revoke"}`. This works immediately because every request checks the row. Rotating `KIOSK_SESSION_SECRET` invalidates every kiosk at once.                                                                                  |
| Enrollment secret brute force                                    | Minimum 20 characters (recommended: 32 random). Rate limit: 10 tries per 15 minutes per IP. Every failure is logged.                                                                                                                                                       |
| Replayed upload                                                  | Idempotent by `session_id`: one row and one object. A replay only rotates the token of a row created **by the same kiosk** while its link is still active. Another kiosk gets 409. The session id only exists in the kiosk's memory and IndexedDB.                         |
| Oversized or malicious body                                      | Body is read with a hard 4 MB cap regardless of `Content-Length`. Allowlist of `image/jpeg`/`image/png`. Magic bytes are checked, and JPEG must end with EOI. The frame id must be known and the session id must be a UUID. The bucket also enforces size and MIME limits. |
| Anon Supabase key leaks (if ever added to the frontend)          | RLS is enabled with no policies, and all table privileges are revoked from `anon`/`authenticated`. The integration tests prove anon can't select, insert, list, sign or download.                                                                                          |
| Broken production config (e.g. localhost QR)                     | `parseServerConfig` refuses non-https or private-network `PUBLIC_BASE_URL`, missing or weak secrets, and disabled kiosk auth in production. The kiosk shows a staff error and logs `config_invalid` at boot.                                                               |
| Photos kept forever                                              | Retention cron deletes the objects and marks rows `DELETED`.                                                                                                                                                                                                               |
| Wall abuse                                                       | Consent can only be set by the kiosk that took the photo. YES → `PENDING`. Nothing auto-approves. A DB constraint makes `APPROVED` impossible without consent.                                                                                                             |
| An unmoderated or withdrawn photo reaches the wall               | `/api/wall/feed` returns only `wall_eligible_photos` (APPROVED ∧ consent ∧ not deleted). The image route re-checks the row on every request. A hidden or deleted photo leaves the screen within one poll (10 s). After 2 min offline the wall drops every cached photo.    |
| PAUSE WALL / SHOW HOLDING SCREEN ignored by a stale display      | Applied on the server: the feed sends no photo ids and the image route returns 404 while either switch is on.                                                                                                                                                              |
| Anyone opens /wall or its APIs                                   | The display must be enrolled (one-time code, HttpOnly session, revocable in /admin). Feed and image return 401 otherwise. Responses carry ids only — no tokens, storage paths or kiosk ids.                                                                                |

Wall rotation (Phase 2-3): `/api/wall/shown` accepts only photo ids from an enrolled display,
same-origin, at most 50 per report and 60 reports a minute. A forged report can only change the
order of photos that are already approved; it can never add a photo to the wall. "지금 띄우기"
is a staff API, refused for anything not approved with consent, and audited.

## Kiosk enrollment flow

```
staff opens /kiosk/enroll on the kiosk device
  → types device name + KIOSK_ENROLL_SECRET (server-only env)
  → POST /api/kiosk/enroll  (same-origin, rate-limited, constant-time compare)
  → server inserts kiosks row, sets
      ftl_kiosk=v1.<kioskId>.<iat>.<exp>.<HMAC-SHA256>; HttpOnly; SameSite=Lax; Secure; Max-Age=90d
  → redirect /kiosk
every upload/consent: verify HMAC + exp + kiosks.revoked_at is null
sliding renewal: a fresh cookie when < 1/3 of lifetime remains
```

Guests never see any of this. On an expired or revoked device, `/kiosk` shows a staff screen, and
uploads already queued wait in IndexedDB ("기기 등록 필요") until the device is enrolled again.

## Staff (Phase 3)

| Threat                                      | Mitigation                                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone with a Supabase account opens /admin | Authorization requires an **active `staff_members` row**, checked server-side on every page and API. Public signup is disabled and OTP uses `shouldCreateUser: false`. A non-staff login is signed out and its cookies expired in the same response. |
| Discovering who is staff                    | The OTP endpoint answers identically for every email and only sends codes to active staff.                                                                                                                                                           |
| OTP guessing                                | 6-digit codes expire in 10 min. Supabase Auth limits verification, and our endpoints add per-IP / per-email limits.                                                                                                                                  |
| Ex-staff keeps access                       | Deactivation is checked on the next request (tested), not at token expiry.                                                                                                                                                                           |
| Stolen staff session cookie                 | Cookies are HttpOnly, SameSite=Lax and Secure. Sessions refresh via `proxy.ts`. Sign-out revokes the refresh token.                                                                                                                                  |
| CSRF on staff actions                       | Every staff mutation requires same-origin + `application/json` (forces a preflight that is never approved).                                                                                                                                          |
| Kiosk ⇄ staff confusion                     | Staff APIs ignore the kiosk cookie, and kiosk APIs ignore the staff session (both tested).                                                                                                                                                           |
| Silent, unaccountable changes               | Audited mutations commit with their `audit_events` row in one SQL transaction. The log is append-only (trigger + grants). Actors are stored as ids, not names.                                                                                       |
| Deleted photo lingers                       | Tombstone first (link dead), then bytes removed. The retention job retries leftovers. DELETED is terminal in app and DB.                                                                                                                             |
| Staff images leak                           | Server proxy after the staff check; `private, no-store`; thumbnails are private objects too. No storage URL ever reaches a browser.                                                                                                                  |
| Enrollment code reuse / guessing            | One-time, 15 min, SHA-256 stored, atomic consume, rate-limited per IP, ~40-bit space.                                                                                                                                                                |
| Supabase user JWT used against PostgREST    | RLS on every table with no policies, and privileges revoked from `authenticated` (tested with a real user JWT).                                                                                                                                      |

## Hub staff login (FTL_ROLE=hub)

| Threat                                | Mitigation                                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PIN guessing                          | 6 digits, trivial PINs refused (`000000`, `123456`…). scrypt hash. **5 wrong PINs per person per 15 min**, keyed by staff id (not IP), plus 20 tries per IP. Wrong PIN, unknown person and inactive person look identical. |
| PIN or hash leaks                     | Only the scrypt hash is stored, apart from the staff row; it never appears in staff lists, API responses or audit rows (tested).                                                                                           |
| Someone claims a fresh hub            | The first staff member needs the one-time setup code printed in the hub's own console. It works only while the hub has no staff, once, rate-limited, same-origin.                                                          |
| Forged or replayed staff cookie       | `s1.<id>.<iat>.<exp>.<pinSetAt>.<hmac>`, HMAC key derived from `KIOSK_SESSION_SECRET` with a staff-only label, so kiosk cookies never verify as staff cookies (tested). Every request re-checks an active staff row.       |
| Ex-staff or a leaked PIN keeps access | Deactivation and PIN resets end existing sessions on the next request (`pinSetAt` must match). Default session 14 h (`STAFF_SESSION_HOURS`).                                                                               |
| Sniffing on the venue LAN             | The hub serves plain HTTP, so cookies are not `Secure` there. The LAN must be the dedicated, password-protected router (D42), never the congregation Wi-Fi.                                                                |

## Accepted limitations

- **Rate limits are per server instance** (in memory). On Vercel each instance counts separately
  and resets on cold start. The real protections are kiosk auth, 192-bit tokens and a long
  enrollment secret. If abuse is ever observed, move the limiter to a Postgres table; Redis is not
  needed.
- **Legacy shared enrollment secret** (`KIOSK_ENROLL_SECRET`) still works if set, and also
  enables the old operator API. Leave it **empty** in production and use one-time codes.
- **One staff role.** Every active staff member can do everything in /admin, including adding and
  deactivating other staff. Keep the list short.
- **Email is the staff login factor.** Whoever controls a staff mailbox can log in. Use personal
  mailboxes, not shared ones.
- **Anyone holding a guest link can view the photo** until it expires. That is the product: the
  link is the credential. Default lifetime is 72 hours.
- **The kiosk device itself is trusted.** Someone with the unlocked kiosk can upload. Physical
  supervision is assumed.
- `x-forwarded-for` is trusted for rate-limit keys. That is correct behind Vercel; on a bare
  server (the hub) it can be spoofed, which only weakens the per-IP limits. The per-person PIN
  limit does not depend on it.
- **Hub PINs are shared verbally.** Whoever learns a staff member's PIN and reaches the venue LAN
  can act as them until the PIN is reset. Reset PINs after the event and when staff change.
