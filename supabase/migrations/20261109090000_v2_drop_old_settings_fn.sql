-- FOLLOW THE LIGHTS 2.0, after the deploy (D67): drop the 8-argument settings function that
-- 20261108090000_v2_kiosk_mode.sql kept while the previous code was still running. The 2.0 code
-- (deployed 2026-11-08, #29/#30) only calls the 9-argument one, so there is again exactly one way
-- to change settings. Re-runnable.
drop function if exists public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, uuid);
