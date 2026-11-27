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

## AI review migration and its SQL tests (D95)

`20261114120000_ai_review.sql` adds the AI review columns on `photos`, the `ai_usage` table, the
`moderation_mode` setting and the `ftl_ai_*` functions. Apply it **before** deploying the code that
uses it; the previous `ftl_settings_update` signature stays as a wrapper, so the running code keeps
working in between. It changes no behaviour by itself (mode `manual`, every photo `NONE`).

The functions, the row trigger and the grants are tested on a real database by
`tests/integration/ai-review-sql.test.ts`. With the local Supabase stack it runs as part of
`npm run test:supabase`. Without Docker, any Postgres 15+ will do:

```bash
createdb ftl && psql ftl <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create schema storage; create table storage.buckets (id text primary key, name text, public boolean,
                                                      file_size_limit bigint, allowed_mime_types text[]);
grant usage on schema public to anon, authenticated, service_role;
SQL
for f in supabase/migrations/*.sql; do psql ftl -v ON_ERROR_STOP=1 -f "$f"; done
FTL_TEST_PG_URL=postgres://<owner>@localhost/ftl npx vitest run tests/integration/ai-review-sql.test.ts
```

The URL is the database owner's (the test re-applies the migration); everything the application
would do runs as `service_role`. The two stub schemas stand in for Supabase's own `auth` and
`storage`; they exist only so the earlier migrations apply.

## Camera engine migration (「카메라 자동 보정」)

`20261127090000_camera_engine.sql` adds `event_settings.camera_engine` (the staff setting as one
object; null = the defaults, mode off), `kiosks.camera_engine` (what each booth last said about
its engine, from the heartbeat) and `ftl_settings_set_camera_engine(p_value jsonb, p_actor_id uuid)`,
which stores the setting and writes its audit row in one transaction. `ftl_settings_update` is
unchanged, so code and migration can go out in either order: without the migration the setting
reads as off and the heartbeat goes without the status; saving the setting in /admin needs it.

`tests/integration/camera-engine-sql.test.ts` checks the function, the audit row, the grants and
the two columns on a real Postgres, the same way as the AI review test above
(`FTL_TEST_PG_URL=… npx vitest run tests/integration/camera-engine-sql.test.ts`).
