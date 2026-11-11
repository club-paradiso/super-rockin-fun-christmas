-- FOLLOW THE LIGHTS — session video (D72): a silent highlight reel of the shoot, downloadable
-- with the photo through the same guest link. Re-runnable, like every migration.
--
-- The video is an object next to the photo in the same private bucket, at a path derived from
-- object_path (lib/storage/photo-service.ts), and is removed whenever the photo's image is. The
-- row only records that it exists. Nothing here reaches the media wall: `wall_eligible_photos`
-- lists its columns explicitly and is unchanged.

alter table public.photos
  add column if not exists video_mime text
    check (video_mime is null or video_mime in ('video/mp4', 'video/webm')),
  -- Same hard cap as KIOSK_CONFIG.videoMaxBytes (the cloud's request bodies end near 4.5 MB).
  add column if not exists video_bytes integer
    check (video_bytes is null or (video_bytes > 0 and video_bytes <= 3500000));

do $$ begin
  alter table public.photos add constraint photos_video_both_or_neither
    check ((video_mime is null) = (video_bytes is null));
exception when duplicate_object then null; end $$;

comment on column public.photos.video_mime is
  'Session video container (D72), or null when the session has none. Never sent to the wall.';

-- The private bucket may now also hold the two video types. Still private, still 4 MiB per object,
-- still no storage.objects policies: only service_role can read or write it.
update storage.buckets
  set public = false,
      allowed_mime_types = array['image/jpeg', 'image/png', 'video/mp4', 'video/webm']
  where id = 'photos';
