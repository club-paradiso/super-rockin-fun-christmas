-- AI review on by default (2026-11-25, a user decision): a photo whose guest said yes to the wall
-- is checked by the AI first and goes up as soon as it is found clearly fine; anything else waits
-- for a person, as before. Without an AI provider configured on the server nothing changes: every
-- photo waits for a person (the code reads `auto` as inactive then).
--
-- New databases start on `auto`. An existing database is switched only if no person has ever set
-- the mode (no audit row records a moderation_mode change): a choice staff made stays. Re-runnable.

alter table public.event_settings
  alter column moderation_mode set default 'auto';

update public.event_settings
   set moderation_mode = 'auto'
 where id = 1
   and moderation_mode = 'manual'
   and not exists (
     select 1 from public.audit_events
      where action = 'update_settings'
        and subject_type = 'settings'
        -- Text matching, not a jsonb cast: an older audit row that is not JSON must not stop this.
        and (
          (from_state like '%"moderation_mode": "manual"%' and to_state like '%"moderation_mode": "auto"%')
          or (from_state like '%"moderation_mode": "auto"%' and to_state like '%"moderation_mode": "manual"%')
        )
   );
