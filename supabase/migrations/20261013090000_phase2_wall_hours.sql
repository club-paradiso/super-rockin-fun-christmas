-- Phase 2-4b: media-wall opening hours with a staff override, and wall display metrics.
-- Re-runnable, like every migration here (tests/integration checks it).

-- ── event settings: opening hours ───────────────────────────────────────────────────────────
alter table public.event_settings
  add column if not exists wall_hours_start text
    check (wall_hours_start is null or wall_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists wall_hours_end text
    check (wall_hours_end is null or wall_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 'auto' follows the hours; 'on' / 'off' are the staff override.
  add column if not exists wall_force text not null default 'auto'
    check (wall_force in ('auto', 'on', 'off'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'event_settings_wall_hours_pair') then
    alter table public.event_settings add constraint event_settings_wall_hours_pair check (
      (wall_hours_start is null) = (wall_hours_end is null)
      and (wall_hours_start is null or wall_hours_start <> wall_hours_end));
  end if;
end $$;

-- ── kiosks: wall display metrics from the heartbeat ─────────────────────────────────────────
alter table public.kiosks
  add column if not exists frame_rate real check (frame_rate is null or frame_rate between 0 and 240),
  add column if not exists memory_mb integer check (memory_mb is null or memory_mb between 0 and 65536);

-- ── settings update: one audited call, now with the hours ───────────────────────────────────
-- The old signature is dropped so there is exactly one way to change settings.
drop function if exists public.ftl_settings_update(boolean, boolean, boolean, uuid);

create or replace function public.ftl_settings_update(
  p_pause_submissions boolean,
  p_pause_wall boolean,
  p_show_holding_screen boolean,
  p_wall_force text,
  -- Hours are nullable themselves: p_set_wall_hours = false leaves them unchanged.
  p_set_wall_hours boolean,
  p_wall_hours_start text,
  p_wall_hours_end text,
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
                             'wall_force', v_old.wall_force)::text,
          jsonb_build_object('pause_submissions', v_row.pause_submissions, 'pause_wall', v_row.pause_wall,
                             'show_holding_screen', v_row.show_holding_screen,
                             'wall_hours', case when v_row.wall_hours_start is null then null
                                                else v_row.wall_hours_start || '-' || v_row.wall_hours_end end,
                             'wall_force', v_row.wall_force)::text);
  return next v_row;
end $$;

revoke all on function public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, uuid)
  to service_role;
