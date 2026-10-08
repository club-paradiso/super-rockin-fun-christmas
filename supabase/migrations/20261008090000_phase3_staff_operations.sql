-- FOLLOW THE LIGHTS — Phase 3: staff authentication, moderation, kiosk management, operations.
--
-- Same access model as Phase 2: only the Next.js server (service_role) touches these tables.
-- Supabase Auth is used to IDENTIFY staff; being an authenticated Supabase user grants nothing.
-- Authorization = an active row in public.staff_members, checked server-side on every request.
--
-- Every audited mutation is a SQL function so the state change and its audit row commit in one
-- transaction: a change can never succeed while its audit record silently fails.

-- ── photos: Phase 3 columns ─────────────────────────────────────────────────────────────────
alter table public.photos
  add column if not exists thumb_path text unique check (thumb_path is null or thumb_path !~ '(^/|\.\.)'),
  -- Set once the image object(s) are gone from storage (staff delete or retention).
  add column if not exists object_deleted_at timestamptz,
  -- First 8 hex chars of the session id, shown small on the kiosk QR screen for staff recovery.
  add column if not exists session_short text generated always as (left(session_id::text, 8)) stored;

create index if not exists photos_created_idx on public.photos (created_at desc);
create index if not exists photos_kiosk_created_idx on public.photos (kiosk_id, created_at desc);
create index if not exists photos_session_short_idx on public.photos (session_short);
create index if not exists photos_object_cleanup_idx
  on public.photos (deleted_at) where deleted_at is not null and object_deleted_at is null;

-- DELETED is terminal, enforced by the database as well as the app.
create or replace function public.ftl_photos_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.moderation_status = 'DELETED' and new.moderation_status <> 'DELETED' then
    raise exception 'photo % is deleted; DELETED is terminal', old.id using errcode = 'check_violation';
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'photo % deletion cannot be undone', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists photos_guard on public.photos;
create trigger photos_guard before update on public.photos
  for each row execute function public.ftl_photos_guard();

-- ── kiosks: heartbeat ───────────────────────────────────────────────────────────────────────
alter table public.kiosks
  add column if not exists heartbeat_at timestamptz,
  add column if not exists queue_depth integer check (queue_depth is null or queue_depth between 0 and 100000),
  add column if not exists camera_state text check (camera_state is null or camera_state in ('ok', 'error', 'unknown')),
  add column if not exists app_build text check (app_build is null or char_length(app_build) <= 64),
  add column if not exists enrolled_via text not null default 'secret' check (enrolled_via in ('secret', 'code'));

-- ── staff allowlist ─────────────────────────────────────────────────────────────────────────
create table if not exists public.staff_members (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  email         text not null unique check (email = lower(email) and position('@' in email) > 1),
  display_name  text not null check (char_length(display_name) between 1 and 64),
  -- One tier today. A column (not a separate table) so roles can be added without a rewrite.
  role          text not null default 'staff' check (role in ('staff')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid
);

comment on table public.staff_members is
  'Staff allowlist. A Supabase Auth user is authorized only with an active row here.';

-- ── append-only audit log ───────────────────────────────────────────────────────────────────
create table if not exists public.audit_events (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_type    text not null check (actor_type in ('staff', 'kiosk', 'system')),
  -- Stable identity (auth user id / kiosk id). Never a display name.
  actor_id      uuid,
  action        text not null check (action ~ '^[a-z_]{2,40}$'),
  subject_type  text not null check (subject_type in ('photo', 'kiosk', 'enrollment_code', 'settings', 'staff')),
  subject_id    text not null,
  from_state    text,
  to_state      text,
  note          text check (note is null or char_length(note) <= 500),
  details       jsonb not null default '{}'::jsonb
);

create index if not exists audit_subject_idx on public.audit_events (subject_type, subject_id, occurred_at desc);
create index if not exists audit_recent_idx on public.audit_events (occurred_at desc);

create or replace function public.ftl_audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.ftl_audit_append_only();

-- ── one-time kiosk enrollment codes ─────────────────────────────────────────────────────────
create table if not exists public.kiosk_enrollment_codes (
  id             uuid primary key,
  -- sha256(code) hex. The code itself is shown once to staff and never stored.
  code_hash      text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  label          text not null check (char_length(label) between 1 and 64),
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_kiosk_id  uuid references public.kiosks (id) on delete set null,
  constraint enrollment_code_expiry check (expires_at > created_at)
);

-- ── event settings (singleton) ──────────────────────────────────────────────────────────────
create table if not exists public.event_settings (
  id                   smallint primary key default 1 check (id = 1),
  -- Stops NEW media-wall submissions only. Photography and QR delivery keep working.
  pause_submissions    boolean not null default false,
  -- Consumed by the Phase 4 wall.
  pause_wall           boolean not null default false,
  show_holding_screen  boolean not null default false,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);
insert into public.event_settings (id) values (1) on conflict (id) do nothing;

-- ── retention runs (operations visibility) ──────────────────────────────────────────────────
create table if not exists public.retention_runs (
  id         bigint generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  examined   integer not null,
  deleted    integer not null,
  failed     integer not null
);
create index if not exists retention_runs_recent_idx on public.retention_runs (ran_at desc);

-- ── Phase 4 source of truth ─────────────────────────────────────────────────────────────────
create or replace view public.wall_eligible_photos with (security_invoker = true) as
  select id, created_at, frame_id, mime, thumb_path, object_path
  from public.photos
  where moderation_status = 'APPROVED' and wall_consent and deleted_at is null;

-- ── audited mutations ───────────────────────────────────────────────────────────────────────

-- Compare-and-set moderation change + audit row, atomically. Returns no row when the photo is
-- missing or its status is no longer p_from (a concurrent change won), so callers can 409.
create or replace function public.ftl_photo_transition(
  p_photo_id uuid,
  p_from public.moderation_status,
  p_to public.moderation_status,
  p_wall_consent boolean,
  p_deleted_at timestamptz,
  p_actor_type text,
  p_actor_id uuid,
  p_action text,
  p_note text
) returns setof public.photos
language plpgsql set search_path = '' as $$
declare
  v_row public.photos;
begin
  update public.photos
     set moderation_status = p_to,
         wall_consent = coalesce(p_wall_consent, wall_consent),
         deleted_at = coalesce(deleted_at, p_deleted_at)
   where id = p_photo_id and moderation_status = p_from
  returning * into v_row;
  if not found then
    return;
  end if;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state, note)
  values (p_actor_type, p_actor_id, p_action, 'photo', p_photo_id::text, p_from::text, p_to::text, p_note);
  return next v_row;
end $$;

-- New guest token for an existing, non-deleted photo ("QR 다시 보여주기"). The old hash is gone.
create or replace function public.ftl_photo_rotate_token(
  p_photo_id uuid,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_actor_id uuid
) returns setof public.photos
language plpgsql set search_path = '' as $$
declare
  v_row public.photos;
begin
  update public.photos
     set token_hash = p_token_hash, token_expires_at = p_token_expires_at
   where id = p_photo_id and deleted_at is null and moderation_status <> 'DELETED'
  returning * into v_row;
  if not found then
    return;
  end if;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, details)
  values ('staff', p_actor_id, 'rotate_token', 'photo', p_photo_id::text,
          jsonb_build_object('token_expires_at', p_token_expires_at));
  return next v_row;
end $$;

-- Rename and/or revoke a kiosk.
create or replace function public.ftl_kiosk_update(
  p_kiosk_id uuid,
  p_label text,
  p_revoke boolean,
  p_actor_id uuid
) returns setof public.kiosks
language plpgsql set search_path = '' as $$
declare
  v_old public.kiosks;
  v_row public.kiosks;
begin
  select * into v_old from public.kiosks where id = p_kiosk_id for update;
  if not found then
    return;
  end if;
  update public.kiosks
     set label = coalesce(p_label, label),
         revoked_at = case when p_revoke then coalesce(revoked_at, now()) else revoked_at end
   where id = p_kiosk_id
  returning * into v_row;
  if p_label is not null and p_label <> v_old.label then
    insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
    values ('staff', p_actor_id, 'rename_kiosk', 'kiosk', p_kiosk_id::text, v_old.label, p_label);
  end if;
  if p_revoke and v_old.revoked_at is null then
    insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
    values ('staff', p_actor_id, 'revoke_kiosk', 'kiosk', p_kiosk_id::text, 'active', 'revoked');
  end if;
  return next v_row;
end $$;

create or replace function public.ftl_enrollment_code_create(
  p_id uuid,
  p_code_hash text,
  p_label text,
  p_expires_at timestamptz,
  p_actor_id uuid
) returns setof public.kiosk_enrollment_codes
language plpgsql set search_path = '' as $$
declare
  v_row public.kiosk_enrollment_codes;
begin
  insert into public.kiosk_enrollment_codes (id, code_hash, label, created_by, expires_at)
  values (p_id, p_code_hash, p_label, p_actor_id, p_expires_at)
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, details)
  values ('staff', p_actor_id, 'create_enrollment_code', 'enrollment_code', p_id::text,
          jsonb_build_object('label', p_label, 'expires_at', p_expires_at));
  return next v_row;
end $$;

-- Exchange a one-time code for a new kiosk. Exactly one caller can ever win a given code.
create or replace function public.ftl_enrollment_code_consume(
  p_code_hash text,
  p_kiosk_id uuid
) returns setof public.kiosks
language plpgsql set search_path = '' as $$
declare
  v_code public.kiosk_enrollment_codes;
  v_kiosk public.kiosks;
begin
  update public.kiosk_enrollment_codes
     set used_at = now()
   where code_hash = p_code_hash and used_at is null and expires_at > now()
  returning * into v_code;
  if not found then
    return;
  end if;
  insert into public.kiosks (id, label, enrolled_via) values (p_kiosk_id, v_code.label, 'code')
  returning * into v_kiosk;
  update public.kiosk_enrollment_codes set used_kiosk_id = p_kiosk_id where id = v_code.id;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, details)
  values ('kiosk', p_kiosk_id, 'use_enrollment_code', 'enrollment_code', v_code.id::text,
          jsonb_build_object('kiosk_id', p_kiosk_id, 'created_by', v_code.created_by));
  return next v_kiosk;
end $$;

create or replace function public.ftl_settings_update(
  p_pause_submissions boolean,
  p_pause_wall boolean,
  p_show_holding_screen boolean,
  p_actor_id uuid
) returns setof public.event_settings
language plpgsql set search_path = '' as $$
declare
  v_old public.event_settings;
  v_row public.event_settings;
begin
  select * into v_old from public.event_settings where id = 1 for update;
  update public.event_settings
     set pause_submissions = coalesce(p_pause_submissions, pause_submissions),
         pause_wall = coalesce(p_pause_wall, pause_wall),
         show_holding_screen = coalesce(p_show_holding_screen, show_holding_screen),
         updated_at = now(),
         updated_by = p_actor_id
   where id = 1
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
  values ('staff', p_actor_id, 'update_settings', 'settings', 'event',
          jsonb_build_object('pause_submissions', v_old.pause_submissions, 'pause_wall', v_old.pause_wall,
                             'show_holding_screen', v_old.show_holding_screen)::text,
          jsonb_build_object('pause_submissions', v_row.pause_submissions, 'pause_wall', v_row.pause_wall,
                             'show_holding_screen', v_row.show_holding_screen)::text);
  return next v_row;
end $$;

-- Add a staff member or change name / active flag.
create or replace function public.ftl_staff_upsert(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_active boolean,
  p_actor_id uuid
) returns setof public.staff_members
language plpgsql set search_path = '' as $$
declare
  v_old public.staff_members;
  v_row public.staff_members;
begin
  select * into v_old from public.staff_members where user_id = p_user_id for update;
  -- NOT NULL is checked on the proposed row before ON CONFLICT, so fill from the existing row.
  insert into public.staff_members (user_id, email, display_name, active, created_by)
  values (p_user_id, lower(p_email), coalesce(p_display_name, v_old.display_name, lower(p_email)),
          coalesce(p_active, v_old.active, true), p_actor_id)
  on conflict (user_id) do update
    set display_name = coalesce(p_display_name, public.staff_members.display_name),
        active = coalesce(p_active, public.staff_members.active)
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
  values (case when p_actor_id is null then 'system' else 'staff' end, p_actor_id,
          case when v_old.user_id is null then 'add_staff'
               when v_old.active and not v_row.active then 'deactivate_staff'
               when not v_old.active and v_row.active then 'activate_staff'
               else 'update_staff' end,
          'staff', p_user_id::text,
          case when v_old.user_id is null then null when v_old.active then 'active' else 'inactive' end,
          case when v_row.active then 'active' else 'inactive' end);
  return next v_row;
end $$;

-- Dashboard counters in one round trip (read-only).
create or replace function public.ftl_photo_stats() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(moderation_status, n)
                           from (select moderation_status, count(*) as n from public.photos group by 1) s), '{}'::jsonb),
    'stored_count', (select count(*) from public.photos where deleted_at is null and object_deleted_at is null),
    'stored_bytes', (select coalesce(sum(bytes), 0) from public.photos where deleted_at is null and object_deleted_at is null)
  );
$$;

-- ── least privilege ─────────────────────────────────────────────────────────────────────────
alter table public.staff_members enable row level security;
alter table public.audit_events enable row level security;
alter table public.kiosk_enrollment_codes enable row level security;
alter table public.event_settings enable row level security;
alter table public.retention_runs enable row level security;

revoke all on table public.staff_members, public.audit_events, public.kiosk_enrollment_codes,
  public.event_settings, public.retention_runs from anon, authenticated;
revoke all on public.wall_eligible_photos from anon, authenticated;
grant select, insert, update, delete on table public.staff_members, public.kiosk_enrollment_codes,
  public.event_settings, public.retention_runs to service_role;
-- Audit: service_role may append and read, never edit (also blocked by trigger).
grant select, insert on table public.audit_events to service_role;
grant select on public.wall_eligible_photos to service_role;

revoke all on function public.ftl_photos_guard(), public.ftl_audit_append_only(),
  public.ftl_photo_transition(uuid, public.moderation_status, public.moderation_status, boolean, timestamptz, text, uuid, text, text),
  public.ftl_photo_rotate_token(uuid, text, timestamptz, uuid),
  public.ftl_kiosk_update(uuid, text, boolean, uuid),
  public.ftl_enrollment_code_create(uuid, text, text, timestamptz, uuid),
  public.ftl_enrollment_code_consume(text, uuid),
  public.ftl_settings_update(boolean, boolean, boolean, uuid),
  public.ftl_staff_upsert(uuid, text, text, boolean, uuid),
  public.ftl_photo_stats()
  from public, anon, authenticated;
grant execute on function
  public.ftl_photo_transition(uuid, public.moderation_status, public.moderation_status, boolean, timestamptz, text, uuid, text, text),
  public.ftl_photo_rotate_token(uuid, text, timestamptz, uuid),
  public.ftl_kiosk_update(uuid, text, boolean, uuid),
  public.ftl_enrollment_code_create(uuid, text, text, timestamptz, uuid),
  public.ftl_enrollment_code_consume(text, uuid),
  public.ftl_settings_update(boolean, boolean, boolean, uuid),
  public.ftl_staff_upsert(uuid, text, text, boolean, uuid),
  public.ftl_photo_stats()
  to service_role;
