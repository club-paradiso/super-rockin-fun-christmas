-- STUDIO SHALOM — Remote Camera Mode (docs/REMOTE_CAMERA.md). Re-runnable, like every migration.
--
-- Holds pairing codes (hash only), paired cameras and a short-lived signaling mailbox. No photo,
-- no video, no image of any kind is stored here: the picture goes phone → iPad directly. The only
-- picture-like value is a ~10 KB staff "test capture" thumbnail inside `report`, which the server
-- nulls after two minutes.
--
-- Every table is RLS-locked and revoked from anon/authenticated: only the Next.js server (service
-- role) touches them.

create table if not exists public.remote_camera_codes (
  code_hash   text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  kiosk_id    uuid not null references public.kiosks(id) on delete cascade,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table if not exists public.remote_camera_pairings (
  id           uuid primary key,
  kiosk_id     uuid not null references public.kiosks(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 40),
  paired_by    text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   text,
  report       jsonb not null default '{}'::jsonb
);

-- One active camera per kiosk.
create unique index if not exists remote_camera_one_active_per_kiosk
  on public.remote_camera_pairings (kiosk_id) where revoked_at is null;

create table if not exists public.remote_camera_signals (
  seq        bigint generated always as identity primary key,
  pairing_id uuid not null references public.remote_camera_pairings(id) on delete cascade,
  kiosk_id   uuid not null,
  from_role  text not null check (from_role in ('kiosk', 'camera', 'admin')),
  to_role    text not null check (to_role in ('kiosk', 'camera')),
  message    jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists remote_camera_signals_poll
  on public.remote_camera_signals (pairing_id, to_role, seq);

alter table public.remote_camera_codes enable row level security;
alter table public.remote_camera_pairings enable row level security;
alter table public.remote_camera_signals enable row level security;
revoke all on table public.remote_camera_codes, public.remote_camera_pairings,
  public.remote_camera_signals from public, anon, authenticated;

-- Single use, atomic: the code is spent, the kiosk's previous camera is revoked and the new
-- pairing exists, or nothing happened. Expiry uses the caller's clock value p_now.
create or replace function public.ftl_camera_consume_code(
  p_code_hash text,
  p_pairing_id uuid,
  p_name text,
  p_now timestamptz
) returns setof public.remote_camera_pairings
language plpgsql
as $$
declare
  v_kiosk uuid;
  v_staff text;
begin
  update public.remote_camera_codes
     set used_at = p_now
   where code_hash = p_code_hash and used_at is null and expires_at > p_now
  returning kiosk_id, created_by into v_kiosk, v_staff;
  if v_kiosk is null then
    return;
  end if;
  update public.remote_camera_pairings
     set revoked_at = p_now, revoked_by = 'replaced'
   where kiosk_id = v_kiosk and revoked_at is null;
  return query
    insert into public.remote_camera_pairings (id, kiosk_id, name, paired_by, created_at, last_seen_at, report)
    values (p_pairing_id, v_kiosk, p_name, v_staff, p_now, p_now, '{"state":"idle","mode":"hq"}'::jsonb)
    returning *;
end $$;

revoke all on function public.ftl_camera_consume_code(text, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ftl_camera_consume_code(text, uuid, text, timestamptz)
  to service_role;
