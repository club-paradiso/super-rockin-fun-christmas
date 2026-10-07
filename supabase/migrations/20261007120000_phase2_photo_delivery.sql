-- FOLLOW THE LIGHTS — Phase 2: private photo delivery.
--
-- Access model: ONLY the Next.js server touches these tables and the bucket, using the
-- service_role key (which bypasses RLS). Browsers never talk to Supabase directly. RLS is
-- enabled with no policies, and table privileges are revoked from anon/authenticated, so even a
-- leaked anon key cannot read rows or photos.

-- ── kiosks ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.kiosks (
  id            uuid primary key,
  label         text not null check (char_length(label) between 1 and 64),
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_seen_at  timestamptz
);

comment on table public.kiosks is
  'Enrolled kiosk devices. A kiosk session cookie is only honoured while revoked_at is null.';

-- ── photos ──────────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.moderation_status as enum
    ('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'HIDDEN', 'DELETED');
exception when duplicate_object then null; end $$;

create table if not exists public.photos (
  id                    uuid primary key,
  -- Kiosk session UUID. Unique = upload idempotency (a retried upload never makes a 2nd row).
  session_id            uuid not null unique,
  kiosk_id              uuid references public.kiosks (id) on delete set null,
  frame_id              text not null check (frame_id ~ '^[a-z0-9-]{1,64}$'),
  mime                  text not null check (mime in ('image/jpeg', 'image/png')),
  bytes                 integer not null check (bytes > 0 and bytes <= 4194304),
  -- Path inside the private bucket. Server-only; never sent to guests.
  object_path           text not null unique check (object_path !~ '(^/|\.\.)'),
  -- SHA-256 (hex) of the 192-bit guest token. The raw token is never stored.
  token_hash            text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at      timestamptz not null,
  retention_expires_at  timestamptz not null,
  wall_consent          boolean not null default false,
  -- Safe default: nothing reaches the wall without consent AND human approval.
  moderation_status     public.moderation_status not null default 'NONE',
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint photos_retention_after_link check (retention_expires_at >= token_expires_at),
  -- Approval requires consent. (Phase 2 never approves anything; this guards Phase 3.)
  constraint photos_approved_needs_consent check (moderation_status <> 'APPROVED' or wall_consent),
  constraint photos_deleted_marked check (deleted_at is null or moderation_status = 'DELETED')
);

comment on column public.photos.token_hash is 'sha256(token) hex. Lookup key for /p/[token].';
comment on column public.photos.object_path is 'Private bucket path. Never exposed to guests.';

-- token_hash and session_id lookups use their UNIQUE indexes. Retention sweep:
create index if not exists photos_retention_due_idx
  on public.photos (retention_expires_at) where deleted_at is null;
-- Phase 3 moderation queue:
create index if not exists photos_moderation_idx
  on public.photos (moderation_status, created_at) where deleted_at is null;

create or replace function public.ftl_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists photos_touch_updated_at on public.photos;
create trigger photos_touch_updated_at before update on public.photos
  for each row execute function public.ftl_touch_updated_at();

-- ── least privilege ─────────────────────────────────────────────────────────────────────────
alter table public.kiosks enable row level security;
alter table public.photos enable row level security;
-- No policies on purpose: anon and authenticated get nothing.
revoke all on table public.kiosks, public.photos from anon, authenticated;
revoke all on function public.ftl_touch_updated_at() from anon, authenticated, public;
grant select, insert, update, delete on table public.kiosks, public.photos to service_role;

-- ── private storage bucket ──────────────────────────────────────────────────────────────────
-- public = false: no unauthenticated object URLs exist. No storage.objects policies are created
-- for this bucket, so anon/authenticated cannot list, read or write it; only service_role can.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 4194304, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
