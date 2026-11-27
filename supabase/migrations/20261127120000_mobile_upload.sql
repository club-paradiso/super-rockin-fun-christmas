-- 「내 사진으로 참여하기」 (D66) behind a staff switch (2026-11-27, a user decision): off by default.
--
-- A new column and its own small function, like photo_looks: `ftl_settings_update` is left exactly
-- as it is, so the code running today keeps working whichever of the two is deployed first.
-- Re-runnable.

alter table public.event_settings
  -- false (default): the booth cover shows no phone button and no phone QR is issued.
  add column if not exists mobile_upload boolean not null default false;

-- Turns the phone way in on or off and writes the audit row in the same transaction.
create or replace function public.ftl_settings_set_mobile_upload(
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
     set mobile_upload = p_enabled,
         updated_at = now(),
         updated_by = p_actor_id
   where id = 1
  returning * into v_row;
  insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, from_state, to_state)
  values ('staff', p_actor_id, 'update_settings', 'settings', 'event',
          jsonb_build_object('mobile_upload', v_old.mobile_upload)::text,
          jsonb_build_object('mobile_upload', v_row.mobile_upload)::text);
  return next v_row;
end $$;

-- ── least privilege ───────────────────────────────────────────────────────────────────────────
revoke all on function public.ftl_settings_set_mobile_upload(boolean, uuid) from public, anon, authenticated;
grant execute on function public.ftl_settings_set_mobile_upload(boolean, uuid) to service_role;
