-- STUDIO SHALOM (D85, D86): media-wall themes, and a wall address that needs no enrollment.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT USES IT. The new code calls the new function
-- signatures below; without them consent, moderation and settings changes fail. The code that is
-- running today keeps working after this migration: the old signatures stay, as thin wrappers, so
-- there is one implementation of each rule. A follow-up migration drops the old signatures once
-- the new code is live (as 20261109090000 did for D67). Re-runnable, like every migration.

-- ── photos: was the wall consent given for the public wall address? (D86) ─────────────────────
-- Consent on the booth used to mean "the screen at the venue". The wall address is now open to
-- anyone, so that is a second, wider promise and it is recorded per photo. Every existing photo
-- keeps the default (false): it was never agreed for the internet, and nothing staff do later can
-- change that. Only the consent transition below sets it.
alter table public.photos
  add column if not exists wall_public boolean not null default false;

alter table public.photos drop constraint if exists photos_wall_public_needs_consent;
alter table public.photos
  add constraint photos_wall_public_needs_consent check (not wall_public or wall_consent);

-- What an anonymous viewer of the wall address may be sent: the wall rule AND public consent.
-- A second view rather than a new column on wall_eligible_photos, which stays exactly as it is.
create or replace view public.wall_public_photos with (security_invoker = true) as
  select id, created_at, frame_id, mime, thumb_path, object_path
  from public.photos
  where moderation_status = 'APPROVED' and wall_consent and wall_public and deleted_at is null;

revoke all on public.wall_public_photos from public, anon, authenticated;
grant select on public.wall_public_photos to service_role;

-- Compare-and-set moderation change + audit row, atomically (as before), now carrying the scope.
-- wall_public only ever changes together with wall_consent: a YES stores the scope it was given
-- with, a NO always clears it, and a staff action (p_wall_consent null) leaves it alone.
create or replace function public.ftl_photo_transition(
  p_photo_id uuid,
  p_from public.moderation_status,
  p_to public.moderation_status,
  p_wall_consent boolean,
  p_wall_public boolean,
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
         wall_public = case when p_wall_consent is null then wall_public
                            else p_wall_consent and coalesce(p_wall_public, false) end,
         deleted_at = coalesce(deleted_at, p_deleted_at)
   where id = p_photo_id and moderation_status = p_from
  returning * into v_row;
  if not found then
    return;
  end if;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state, note, details)
  values (p_actor_type, p_actor_id, p_action, 'photo', p_photo_id::text, p_from::text, p_to::text, p_note,
          case when p_wall_consent is null then '{}'::jsonb
               else jsonb_build_object('wall_public', v_row.wall_public) end);
  return next v_row;
end $$;

-- The 9-argument signature the running code calls: the same rule, venue scope.
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
language sql set search_path = '' as $$
  select * from public.ftl_photo_transition(
    p_photo_id, p_from, p_to, p_wall_consent, null::boolean, p_deleted_at,
    p_actor_type, p_actor_id, p_action, p_note);
$$;

revoke all on function public.ftl_photo_transition(uuid, public.moderation_status, public.moderation_status, boolean, boolean, timestamptz, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ftl_photo_transition(uuid, public.moderation_status, public.moderation_status, boolean, boolean, timestamptz, text, uuid, text, text)
  to service_role;

-- ── settings: public wall switch (D86) and wall background (D85) ──────────────────────────────
alter table public.event_settings
  -- Off by default: an anonymous viewer of the wall address is sent no photos.
  add column if not exists wall_public boolean not null default false,
  -- {"theme": id, "rotate": bool, "rotateMinutes": n, "rotation": [ids]}. The app validates the
  -- ids against config/wall-themes.ts on every read; an empty object means the default theme.
  add column if not exists wall_look jsonb not null default '{}'::jsonb
    check (jsonb_typeof(wall_look) = 'object');

create or replace function public.ftl_settings_update(
  p_pause_submissions boolean,
  p_pause_wall boolean,
  p_show_holding_screen boolean,
  p_wall_force text,
  -- Hours are nullable themselves: p_set_wall_hours = false leaves them unchanged.
  p_set_wall_hours boolean,
  p_wall_hours_start text,
  p_wall_hours_end text,
  p_kiosk_default_mode text,
  p_wall_public boolean,
  p_wall_look jsonb,
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
                             'wall_look', v_old.wall_look)::text,
          jsonb_build_object('pause_submissions', v_row.pause_submissions, 'pause_wall', v_row.pause_wall,
                             'show_holding_screen', v_row.show_holding_screen,
                             'wall_hours', case when v_row.wall_hours_start is null then null
                                                else v_row.wall_hours_start || '-' || v_row.wall_hours_end end,
                             'wall_force', v_row.wall_force,
                             'kiosk_default_mode', v_row.kiosk_default_mode,
                             'wall_public', v_row.wall_public,
                             'wall_look', v_row.wall_look)::text);
  return next v_row;
end $$;

-- The 9-argument signature the running code calls: the same rule, new settings untouched.
create or replace function public.ftl_settings_update(
  p_pause_submissions boolean,
  p_pause_wall boolean,
  p_show_holding_screen boolean,
  p_wall_force text,
  p_set_wall_hours boolean,
  p_wall_hours_start text,
  p_wall_hours_end text,
  p_kiosk_default_mode text,
  p_actor_id uuid
) returns setof public.event_settings
language sql set search_path = '' as $$
  select * from public.ftl_settings_update(
    p_pause_submissions, p_pause_wall, p_show_holding_screen, p_wall_force,
    p_set_wall_hours, p_wall_hours_start, p_wall_hours_end, p_kiosk_default_mode,
    null::boolean, null::jsonb, p_actor_id);
$$;

revoke all on function public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, boolean, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, boolean, jsonb, uuid)
  to service_role;
