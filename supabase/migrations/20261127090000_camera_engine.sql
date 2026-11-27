-- Intelligent Camera Engine (「카메라 자동 보정」, lib/camera-engine): the staff setting and what
-- each booth last said about its own engine.
--
-- Two new columns and one small function. `ftl_settings_update` is left exactly as it is, so the
-- code running today keeps working whichever of the two is deployed first: without this
-- migration the setting reads as its default (mode off) and the heartbeat goes without the
-- status. Re-runnable.

alter table public.event_settings
  -- null (default): lib/camera-engine/settings.ts `defaultCameraEngine()`, mode "off": every
  -- booth photographs exactly as before. Otherwise the whole setting as one object; the server
  -- validates it on the way in (`cameraEngineProblem`) and reads it leniently (`normalizeCameraEngine`).
  add column if not exists camera_engine jsonb
    check (camera_engine is null or jsonb_typeof(camera_engine) = 'object');

alter table public.kiosks
  -- lib/camera-engine/status.ts `CameraEngineStatus` from the booth's last heartbeat: codes and
  -- rounded numbers only. Null: the booth has the engine off, or has not said.
  add column if not exists camera_engine jsonb
    check (camera_engine is null or jsonb_typeof(camera_engine) = 'object');

-- Stores the camera-engine setting and writes the audit row in the same transaction.
create or replace function public.ftl_settings_set_camera_engine(
  p_value jsonb,
  p_actor_id uuid
) returns setof public.event_settings
language plpgsql set search_path = '' as $$
declare
  v_old public.event_settings;
  v_row public.event_settings;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'p_value must be a json object';
  end if;
  select * into v_old from public.event_settings where id = 1 for update;
  update public.event_settings
     set camera_engine = p_value,
         updated_at = now(),
         updated_by = p_actor_id
   where id = 1
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
  values ('staff', p_actor_id, 'update_settings', 'settings', 'event',
          jsonb_build_object('camera_engine', v_old.camera_engine)::text,
          jsonb_build_object('camera_engine', v_row.camera_engine)::text);
  return next v_row;
end $$;

-- ── least privilege ───────────────────────────────────────────────────────────────────────────
revoke all on function public.ftl_settings_set_camera_engine(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.ftl_settings_set_camera_engine(jsonb, uuid) to service_role;
