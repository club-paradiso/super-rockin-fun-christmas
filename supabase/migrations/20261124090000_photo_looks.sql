-- Colour looks on the booth's photos (lib/looks): one staff switch, off by default.
--
-- A new column and its own small function. `ftl_settings_update` is left exactly as it is, so the
-- code running today keeps working whichever of the two is deployed first. Re-runnable.

alter table public.event_settings
  -- false (default): every photo keeps its frame's own tone, as before looks existed.
  add column if not exists photo_looks boolean not null default false;

-- Turns looks on or off and writes the audit row in the same transaction.
create or replace function public.ftl_settings_set_looks(
  p_enabled boolean,
  p_actor_id uuid
) returns setof public.event_settings
language plpgsql set search_path = '' as $$
declare
  v_old public.event_settings;
  v_row public.event_settings;
begin
  if p_enabled is null then
    raise exception 'p_enabled must not be null';
  end if;
  select * into v_old from public.event_settings where id = 1 for update;
  update public.event_settings
     set photo_looks = p_enabled,
         updated_at = now(),
         updated_by = p_actor_id
   where id = 1
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
  values ('staff', p_actor_id, 'update_settings', 'settings', 'event',
          jsonb_build_object('photo_looks', v_old.photo_looks)::text,
          jsonb_build_object('photo_looks', v_row.photo_looks)::text);
  return next v_row;
end $$;

-- ── least privilege ───────────────────────────────────────────────────────────────────────────
revoke all on function public.ftl_settings_set_looks(boolean, uuid) from public, anon, authenticated;
grant execute on function public.ftl_settings_set_looks(boolean, uuid) to service_role;
