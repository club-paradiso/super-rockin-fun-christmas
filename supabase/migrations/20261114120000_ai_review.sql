-- STUDIO SHALOM (D95): AI-assisted review of photos waiting for the media wall.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT USES IT. The new code calls the new functions and the
-- new `ftl_settings_update` signature below. The code that is running today keeps working after
-- this migration: its `ftl_settings_update` signature stays, as a thin wrapper. Re-runnable.
--
-- What this adds, and what it does not:
--   * The photo row is the review job: `ai_status` QUEUED, claimed with a lease, finished with a
--     compare-and-set. No queue table, no in-memory queue.
--   * Exactly ONE new way for a photo to become APPROVED: `ftl_ai_complete` with outcome SAFE,
--     and only for a row that is still PENDING, has wall consent, is not deleted, holds the
--     caller's claim, while the event is in "auto" mode. It writes the audit event in the same
--     transaction. Everything else the AI says leaves the photo PENDING for a person.
--   * `moderation_status` keeps its meaning. A person's decision is never undone: a photo that
--     leaves PENDING while still queued is taken out of the AI's hands by the row trigger.
--   * Nothing here is visible to the wall: `wall_eligible_photos` and `wall_public_photos` list
--     their columns explicitly and are unchanged. Default mode is "manual": applying this
--     migration changes no behaviour until staff switch the mode on.

-- ── photos: the AI review record ──────────────────────────────────────────────────────────────
alter table public.photos
  add column if not exists ai_status text not null default 'NONE'
    check (ai_status in ('NONE', 'QUEUED', 'SAFE', 'UNSAFE', 'UNCERTAIN', 'FAILED', 'SKIPPED')),
  -- Provider requests started for this photo, ever. The app bounds it (config/moderation.ts).
  add column if not exists ai_attempts smallint not null default 0
    check (ai_attempts between 0 and 20),
  add column if not exists ai_next_attempt_at timestamptz,
  add column if not exists ai_claim uuid,
  add column if not exists ai_claim_until timestamptz,
  -- Codes only: never the provider's free text.
  add column if not exists ai_reason text
    check (ai_reason is null or ai_reason ~ '^[a-z0-9_]{1,40}$'),
  add column if not exists ai_categories text[] not null default '{}'
    check (cardinality(ai_categories) <= 16),
  add column if not exists ai_provider text
    check (ai_provider is null or char_length(ai_provider) <= 40),
  add column if not exists ai_model text
    check (ai_model is null or char_length(ai_model) <= 80),
  add column if not exists ai_latency_ms integer
    check (ai_latency_ms is null or ai_latency_ms >= 0),
  add column if not exists ai_queued_at timestamptz,
  add column if not exists ai_reviewed_at timestamptz;

do $$ begin
  alter table public.photos add constraint photos_ai_claim_only_while_queued
    check (ai_claim is null or ai_status = 'QUEUED');
exception when duplicate_object then null; end $$;

create index if not exists photos_ai_due_idx
  on public.photos (ai_next_attempt_at) where ai_status = 'QUEUED';

comment on column public.photos.ai_status is
  'AI review (D95). What the machine thinks; moderation_status is what was decided. Never sent to the wall.';

-- DELETED stays terminal (as before), and a person always wins over the AI: when a photo leaves
-- PENDING while it is still queued, the guest took the consent back (not queued any more) or
-- somebody decided (SKIPPED). A late AI answer then finds no claim to complete. The AI's own
-- approval changes ai_status in the same statement, so it is not caught here.
create or replace function public.ftl_photos_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.moderation_status = 'DELETED' and new.moderation_status <> 'DELETED' then
    raise exception 'photo % is deleted; DELETED is terminal', old.id using errcode = 'check_violation';
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'photo % deletion cannot be undone', old.id using errcode = 'check_violation';
  end if;
  if old.ai_status = 'QUEUED' and new.ai_status = 'QUEUED'
     and old.moderation_status = 'PENDING' and new.moderation_status <> 'PENDING' then
    new.ai_claim := null;
    new.ai_claim_until := null;
    new.ai_next_attempt_at := null;
    if new.moderation_status = 'NONE' then
      new.ai_status := 'NONE';
      new.ai_queued_at := null;
    else
      new.ai_status := 'SKIPPED';
      new.ai_reason := 'human_decided';
    end if;
  end if;
  return new;
end $$;

-- ── usage: one row per day, counted here (an estimate of the provider's own quota) ────────────
create table if not exists public.ai_usage (
  day                  date primary key,
  requests             integer not null default 0 check (requests >= 0),
  succeeded            integer not null default 0 check (succeeded >= 0),
  failed               integer not null default 0 check (failed >= 0),
  approved             integer not null default 0 check (approved >= 0),
  flagged              integer not null default 0 check (flagged >= 0),
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  last_failure_reason  text check (last_failure_reason is null or last_failure_reason ~ '^[a-z0-9_]{1,40}$')
);
alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from public, anon, authenticated;
grant select, insert, update on table public.ai_usage to service_role;

-- ── settings: who approves ────────────────────────────────────────────────────────────────────
alter table public.event_settings
  -- 'manual': a person approves every photo (default). 'auto': the AI approves what it finds
  -- clearly fine; the rest still waits for a person. There is no mode without review.
  add column if not exists moderation_mode text not null default 'manual'
    check (moderation_mode in ('manual', 'auto'));

create or replace function public.ftl_settings_update(
  p_pause_submissions boolean,
  p_pause_wall boolean,
  p_show_holding_screen boolean,
  p_wall_force text,
  p_set_wall_hours boolean,
  p_wall_hours_start text,
  p_wall_hours_end text,
  p_kiosk_default_mode text,
  p_wall_public boolean,
  p_wall_look jsonb,
  p_moderation_mode text,
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
         wall_force = coalesce(p_wall_force, wall_force),
         wall_hours_start = case when p_set_wall_hours then p_wall_hours_start else wall_hours_start end,
         wall_hours_end = case when p_set_wall_hours then p_wall_hours_end else wall_hours_end end,
         kiosk_default_mode = coalesce(p_kiosk_default_mode, kiosk_default_mode),
         wall_public = coalesce(p_wall_public, wall_public),
         wall_look = coalesce(p_wall_look, wall_look),
         moderation_mode = coalesce(p_moderation_mode, moderation_mode),
         updated_at = now(),
         updated_by = p_actor_id
   where id = 1
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
  values ('staff', p_actor_id, 'update_settings', 'settings', 'event',
          jsonb_build_object('pause_submissions', v_old.pause_submissions, 'pause_wall', v_old.pause_wall,
                             'show_holding_screen', v_old.show_holding_screen,
                             'wall_hours', case when v_old.wall_hours_start is null then null
                                                else v_old.wall_hours_start || '-' || v_old.wall_hours_end end,
                             'wall_force', v_old.wall_force,
                             'kiosk_default_mode', v_old.kiosk_default_mode,
                             'wall_public', v_old.wall_public,
                             'wall_look', v_old.wall_look,
                             'moderation_mode', v_old.moderation_mode)::text,
          jsonb_build_object('pause_submissions', v_row.pause_submissions, 'pause_wall', v_row.pause_wall,
                             'show_holding_screen', v_row.show_holding_screen,
                             'wall_hours', case when v_row.wall_hours_start is null then null
                                                else v_row.wall_hours_start || '-' || v_row.wall_hours_end end,
                             'wall_force', v_row.wall_force,
                             'kiosk_default_mode', v_row.kiosk_default_mode,
                             'wall_public', v_row.wall_public,
                             'wall_look', v_row.wall_look,
                             'moderation_mode', v_row.moderation_mode)::text);
  return next v_row;
end $$;

-- The 11-argument signature the running code calls: the same rule, the mode untouched.
create or replace function public.ftl_settings_update(
  p_pause_submissions boolean,
  p_pause_wall boolean,
  p_show_holding_screen boolean,
  p_wall_force text,
  p_set_wall_hours boolean,
  p_wall_hours_start text,
  p_wall_hours_end text,
  p_kiosk_default_mode text,
  p_wall_public boolean,
  p_wall_look jsonb,
  p_actor_id uuid
) returns setof public.event_settings
language sql set search_path = '' as $$
  select * from public.ftl_settings_update(
    p_pause_submissions, p_pause_wall, p_show_holding_screen, p_wall_force,
    p_set_wall_hours, p_wall_hours_start, p_wall_hours_end, p_kiosk_default_mode,
    p_wall_public, p_wall_look, null::text, p_actor_id);
$$;

-- ── the queue ─────────────────────────────────────────────────────────────────────────────────

-- NONE → QUEUED, only for a photo a person would be looking at anyway. False = nothing changed.
create or replace function public.ftl_ai_enqueue(
  p_photo_id uuid,
  p_now timestamptz,
  p_max_attempts integer
) returns boolean
language plpgsql set search_path = '' as $$
begin
  update public.photos
     set ai_status = 'QUEUED',
         ai_next_attempt_at = p_now,
         ai_queued_at = p_now,
         ai_reason = null,
         ai_categories = '{}'
   where id = p_photo_id
     and ai_status = 'NONE'
     and ai_attempts < p_max_attempts
     and moderation_status = 'PENDING' and wall_consent and deleted_at is null;
  return found;
end $$;

-- Hand out due photos, each to one caller (SKIP LOCKED + lease). Counts the attempt. A queued
-- photo whose attempts are used up with no live claim (its worker died) becomes FAILED.
create or replace function public.ftl_ai_claim(
  p_now timestamptz,
  p_lease_until timestamptz,
  p_limit integer,
  p_max_attempts integer,
  p_photo_id uuid
) returns setof public.photos
language plpgsql set search_path = '' as $$
begin
  update public.photos
     set ai_status = 'FAILED',
         ai_reason = 'interrupted',
         ai_claim = null,
         ai_claim_until = null,
         ai_next_attempt_at = null,
         ai_reviewed_at = p_now
   where ai_status = 'QUEUED'
     and ai_attempts >= p_max_attempts
     and (ai_claim_until is null or ai_claim_until <= p_now)
     and moderation_status = 'PENDING' and wall_consent and deleted_at is null
     and (p_photo_id is null or id = p_photo_id);
  return query
    with due as (
      select id from public.photos
       where ai_status = 'QUEUED'
         and moderation_status = 'PENDING' and wall_consent and deleted_at is null
         and (ai_claim_until is null or ai_claim_until <= p_now)
         and coalesce(ai_next_attempt_at, p_now) <= p_now
         and ai_attempts < p_max_attempts
         and (p_photo_id is null or id = p_photo_id)
       order by created_at
       limit greatest(p_limit, 0)
       for update skip locked
    )
    update public.photos p
       set ai_attempts = p.ai_attempts + 1,
           ai_claim = pg_catalog.gen_random_uuid(),
           ai_claim_until = p_lease_until
      from due
     where p.id = due.id
    returning p.*;
end $$;

-- The answer for a claimed photo. One transaction: usage counters, the verdict, and for SAFE the
-- approval with its audit event. Returns {"applied","approved"}. `applied` false = the claim is
-- gone (a person decided, the consent was withdrawn, the lease was lost): nothing was changed.
create or replace function public.ftl_ai_complete(
  p_photo_id uuid,
  p_claim uuid,
  p_outcome text,
  p_reason text,
  p_categories text[],
  p_provider text,
  p_model text,
  p_latency_ms integer,
  p_next_attempt_at timestamptz,
  p_called boolean,
  p_now timestamptz,
  p_day date
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_row public.photos;
  v_approve boolean := false;
  v_auto boolean := false;
  v_answered boolean := p_outcome in ('SAFE', 'UNSAFE', 'UNCERTAIN');
begin
  if p_outcome not in ('SAFE', 'UNSAFE', 'UNCERTAIN', 'FAILED', 'SKIPPED', 'RETRY') then
    raise exception 'unknown AI outcome %', p_outcome using errcode = 'check_violation';
  end if;

  if p_called and (v_answered or p_outcome in ('FAILED', 'RETRY')) then
    insert into public.ai_usage (day) values (p_day) on conflict (day) do nothing;
    update public.ai_usage
       set succeeded = succeeded + (case when v_answered then 1 else 0 end),
           flagged = flagged + (case when p_outcome = 'UNSAFE' then 1 else 0 end),
           failed = failed + (case when v_answered then 0 else 1 end),
           last_success_at = case when v_answered then p_now else last_success_at end,
           last_failure_at = case when v_answered then last_failure_at else p_now end,
           last_failure_reason = case when v_answered then last_failure_reason else p_reason end
     where day = p_day;
  end if;

  select * into v_row from public.photos
   where id = p_photo_id and ai_status = 'QUEUED' and ai_claim = p_claim
     for update;
  if not found then
    return jsonb_build_object('applied', false, 'approved', false);
  end if;

  if p_outcome = 'RETRY' then
    update public.photos
       set ai_claim = null, ai_claim_until = null, ai_next_attempt_at = p_next_attempt_at
     where id = p_photo_id;
    return jsonb_build_object('applied', true, 'approved', false);
  end if;

  -- The mode is read under a lock: a switch to manual that commits first always wins.
  if p_outcome = 'SAFE' then
    perform 1 from public.event_settings where id = 1 and moderation_mode = 'auto' for share;
    v_auto := found;
  end if;
  v_approve := v_auto
    and v_row.moderation_status = 'PENDING' and v_row.wall_consent and v_row.deleted_at is null;

  update public.photos
     set ai_status = p_outcome,
         ai_claim = null,
         ai_claim_until = null,
         ai_next_attempt_at = null,
         ai_reason = p_reason,
         ai_categories = coalesce(p_categories, '{}'),
         ai_provider = p_provider,
         ai_model = p_model,
         ai_latency_ms = p_latency_ms,
         ai_reviewed_at = p_now,
         moderation_status = case when v_approve then 'APPROVED'::public.moderation_status
                                  else moderation_status end
   where id = p_photo_id;

  if v_approve then
    update public.ai_usage set approved = approved + 1 where day = p_day;
    insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state, details)
    values ('system', null, 'ai_approve', 'photo', p_photo_id::text, 'PENDING', 'APPROVED',
            jsonb_build_object('provider', p_provider, 'model', p_model));
  elsif p_outcome = 'UNSAFE' then
    insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state, details)
    values ('system', null, 'ai_flag', 'photo', p_photo_id::text,
            v_row.moderation_status::text, v_row.moderation_status::text,
            jsonb_build_object('provider', p_provider, 'model', p_model,
                               'categories', to_jsonb(coalesce(p_categories, '{}'))));
  end if;
  return jsonb_build_object('applied', true, 'approved', v_approve);
end $$;

-- Count one provider request against the day unless the day is already at the limit.
create or replace function public.ftl_ai_budget_take(
  p_day date,
  p_limit integer
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_used integer;
begin
  insert into public.ai_usage (day) values (p_day) on conflict (day) do nothing;
  update public.ai_usage set requests = requests + 1
   where day = p_day and requests < p_limit
  returning requests into v_used;
  if found then
    return jsonb_build_object('allowed', true, 'used', v_used);
  end if;
  select requests into v_used from public.ai_usage where day = p_day;
  return jsonb_build_object('allowed', false, 'used', coalesce(v_used, 0));
end $$;

-- Dashboard: the day's counters and the waiting photos by AI state, in one round trip.
create or replace function public.ftl_ai_status(p_day date) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'usage', (select to_jsonb(u) from public.ai_usage u where u.day = p_day),
    'pending', coalesce((select jsonb_object_agg(ai_status, n)
                           from (select ai_status, count(*) as n from public.photos
                                  where moderation_status = 'PENDING' and wall_consent and deleted_at is null
                                  group by 1) s), '{}'::jsonb)
  );
$$;

-- ── least privilege ───────────────────────────────────────────────────────────────────────────
revoke all on function
  public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, boolean, jsonb, text, uuid),
  public.ftl_ai_enqueue(uuid, timestamptz, integer),
  public.ftl_ai_claim(timestamptz, timestamptz, integer, integer, uuid),
  public.ftl_ai_complete(uuid, uuid, text, text, text[], text, text, integer, timestamptz, boolean, timestamptz, date),
  public.ftl_ai_budget_take(date, integer),
  public.ftl_ai_status(date)
  from public, anon, authenticated;
grant execute on function
  public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, boolean, jsonb, text, uuid),
  public.ftl_ai_enqueue(uuid, timestamptz, integer),
  public.ftl_ai_claim(timestamptz, timestamptz, integer, integer, uuid),
  public.ftl_ai_complete(uuid, uuid, text, text, text[], text, text, integer, timestamptz, boolean, timestamptz, date),
  public.ftl_ai_budget_take(date, integer),
  public.ftl_ai_status(date)
  to service_role;
