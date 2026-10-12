# Supabase

Migrations live in `supabase/migrations/` and are the only source of truth. Never click schema
changes in the dashboard.

## Objects

**`public.kiosks`**: enrolled devices: `id`, `label`, `created_at`, `revoked_at`, `last_seen_at`.

**`public.photos`**: one row per kiosk session.

| column                                   | notes                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `id` uuid PK                             | internal                                                           |
| `session_id` uuid **unique**             | kiosk session; upload idempotency key                              |
| `kiosk_id` uuid → kiosks                 | which device uploaded                                              |
| `frame_id`, `mime`, `bytes`              | checked (`bytes ≤ 4 MB`, JPEG/PNG)                                 |
| `object_path` text unique                | private bucket path `YYYY-MM/<uuid>.jpg`, never sent to guests     |
| `token_hash` text **unique**             | `sha256(token)` hex; lookup key for `/p/[token]`                   |
| `token_expires_at`                       | guest link expiry (`PHOTO_LINK_TTL_HOURS`)                         |
| `retention_expires_at`                   | object deletion time (`PHOTO_RETENTION_DAYS`); check ≥ link expiry |
| `wall_consent` bool, default false       | guest's choice                                                     |
| `moderation_status` enum, default `NONE` | `NONE · PENDING · APPROVED · REJECTED · HIDDEN · DELETED`          |
| `deleted_at`                             | set by retention; implies `DELETED`                                |
| `created_at`, `updated_at`               | `updated_at` maintained by trigger                                 |

Constraints: `APPROVED` requires `wall_consent`, and `object_path` may not contain `..` or start
with `/`.

Indexes:

- unique (`session_id`) and unique (`token_hash`)
- partial `retention_expires_at where deleted_at is null` (cleanup)
- partial `(moderation_status, created_at)` (Phase 3 queue)

**Bucket `photos`**: `public = false`, 4 MB limit, `image/jpeg`/`image/png` only. No
`storage.objects` policies, so only `service_role` can touch it.

### Phase 3 additions (`20261008090000_phase3_staff_operations.sql`)

| object                                                                                                                                                                                 | purpose                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `photos.thumb_path`, `photos.object_deleted_at`, `photos.session_short` (generated)                                                                                                    | review thumbnail; image actually removed; short session code for recovery       |
| trigger `photos_guard`                                                                                                                                                                 | DELETED is terminal; `deleted_at` cannot be cleared                             |
| `kiosks.heartbeat_at, queue_depth, camera_state, app_build, enrolled_via`                                                                                                              | kiosk health                                                                    |
| `staff_members` (`user_id` → `auth.users`, `email`, `display_name`, `role`, `active`)                                                                                                  | staff allowlist                                                                 |
| `audit_events` (append-only: trigger + no UPDATE/DELETE grant)                                                                                                                         | who/what/when for every audited change; actors are ids                          |
| `kiosk_enrollment_codes` (`code_hash` unique, `expires_at`, `used_at`)                                                                                                                 | one-time kiosk enrollment                                                       |
| `event_settings` (singleton `id = 1`)                                                                                                                                                  | `pause_submissions`, `pause_wall`, `show_holding_screen`                        |
| `retention_runs`                                                                                                                                                                       | last cleanup result for the dashboard                                           |
| view `wall_eligible_photos`                                                                                                                                                            | APPROVED ∧ wall_consent ∧ not deleted — read by `/api/wall/feed` (service role) |
| functions `ftl_photo_transition`, `ftl_photo_rotate_token`, `ftl_kiosk_update`, `ftl_enrollment_code_create`, `ftl_enrollment_code_consume`, `ftl_settings_update`, `ftl_staff_upsert` | each = state change + audit row in one transaction                              |
| function `ftl_photo_stats()`                                                                                                                                                           | dashboard counters in one call                                                  |

Auth config (local `supabase/config.toml`, mirror it on the hosted project):

- `enable_signup = false`
- email OTP 6 digits, 10-minute expiry
- magic-link template showing `{{ .Token }}` (`supabase/templates/staff-login.html`)

## Least privilege

- RLS is enabled on **every** table with **no policies**; the view uses `security_invoker`.
- `revoke all … from anon, authenticated` on every table, the view and every `ftl_*` function; grants
  only to `service_role`.
- Supabase Auth now holds staff identities. Being an `authenticated` user still grants **no** table
  or function access (tested with a real user JWT).
- The app uses `SUPABASE_SERVICE_ROLE_KEY` **only on the server**, in `lib/storage/supabase-backend.ts`
  (imports `server-only`). The browser never receives a Supabase URL or key.
- Verified by `tests/integration/supabase.test.ts`: anon cannot select or insert rows, and cannot
  list, sign, download or upload objects; the public object URL fails; `authenticated` has no
  table privileges.

## Applying migrations

Hosted project:

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push          # applies supabase/migrations in order
```

Local stack (Docker):

```bash
npx supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,realtime,supavisor,postgres-meta
npm run test:supabase
npx supabase stop
```

The migration is idempotent (`if not exists`, `on conflict do update`), and re-running it is part
of the integration tests.
