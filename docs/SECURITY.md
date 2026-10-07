# Security model (Phase 2)

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

## Accepted limitations

- **Rate limits are per server instance** (in memory). On Vercel each instance counts separately
  and resets on cold start. The real protections are kiosk auth, 192-bit tokens and a long
  enrollment secret. If abuse is ever observed, move the limiter to a Postgres table; Redis is not
  needed.
- **The enrollment secret doubles as the operator API key** until Phase 3 adds staff accounts.
  Keep it with the event lead only and rotate it after the event.
- **Anyone holding a guest link can view the photo** until it expires. That is the product: the
  link is the credential. Default lifetime is 72 hours.
- **The kiosk device itself is trusted.** Someone with the unlocked kiosk can upload. Physical
  supervision is assumed.
- `x-forwarded-for` is trusted for rate-limit keys. That is correct behind Vercel; on a bare
  server it can be spoofed, which only weakens the rate limit.
