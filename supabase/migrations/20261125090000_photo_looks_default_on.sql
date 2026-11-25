-- Colour looks on by default (2026-11-25, a user decision): the guest chooses a colour on the
-- photo choice screen unless staff turn 「사진 색 보정」 off.
--
-- New databases start on. An existing database is switched on only if no person has ever set the
-- switch (no audit row mentions photo_looks): a choice staff made stays. Re-runnable.

alter table public.event_settings
  alter column photo_looks set default true;

update public.event_settings
   set photo_looks = true
 where id = 1
   and photo_looks = false
   and not exists (
     select 1 from public.audit_events
      where action = 'update_settings'
        and subject_type = 'settings'
        and to_state like '%photo_looks%'
   );
