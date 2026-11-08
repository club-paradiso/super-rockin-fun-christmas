-- FOLLOW THE LIGHTS 2.0 (D67): the booth's start mode for each new guest ("standard" or "easy").
-- Guests can switch at any time; staff only choose the default. Re-runnable, like every migration.
-- Mobile uploads (D66) need no schema change: they are photos with frame_id 'phone-photo'.

alter table public.event_settings
  add column if not exists kiosk_default_mode text not null default 'standard'
    check (kiosk_default_mode in ('standard', 'easy'));

-- ── settings update: one audited call, now with the start mode ──────────────────────────────
-- The previous 8-argument signature is KEPT for now: this migration is applied before the new code
-- is deployed, and the running code still calls it (emergency switches must keep working in
-- between). It never touches kiosk_default_mode. A follow-up migration drops it once the new code
-- is live, so there is again exactly one way to change settings.

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
                             'kiosk_default_mode', v_old.kiosk_default_mode)::text,
          jsonb_build_object('pause_submissions', v_row.pause_submissions, 'pause_wall', v_row.pause_wall,
                             'show_holding_screen', v_row.show_holding_screen,
                             'wall_hours', case when v_row.wall_hours_start is null then null
                                                else v_row.wall_hours_start || '-' || v_row.wall_hours_end end,
                             'wall_force', v_row.wall_force,
                             'kiosk_default_mode', v_row.kiosk_default_mode)::text);
  return next v_row;
end $$;

revoke all on function public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, uuid)
  to service_role;
