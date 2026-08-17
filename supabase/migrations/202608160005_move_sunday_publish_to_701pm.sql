-- Move the Sunday auto-publish from 8:30 PM Pacific to 7:01 PM Pacific
-- (1 minute after the 7 PM confirmation deadline).
--
-- 7:01 PM PDT = 02:01 UTC  → 1 2,3 * * 1
-- 7:01 PM PST = 03:01 UTC  → (same cron, off-DST fire deduped by idempotent
--   publish — the second fire is a no-op once the week is already published)
--
-- The auto-publish requires the confirmation deadline to have passed
-- (deadlinePassed = true). At 7:01 PM the deadline has passed by 1 minute,
-- so publish_and_update_schedule fires and the schedule publishes immediately.
--
-- Keeps the surgical wrapper from 202608160004 (publish_and_update_schedule),
-- which preserves confirmed driver assignments and only fits new riders
-- (from late check-ins) into spare car capacity. Does NOT call the full
-- regeneration wrapper, which would reshuffle confirmed drives and
-- regress PR #126.
--
-- This also fixes the Sunday night-before gap: the night-before summary
-- fires at 7:45 PM Pacific, which is now 44 minutes after the publish
-- (was 15 minutes before it at 8:30 PM). The night-before will find a
-- published version for Monday's trips.
--
-- Supersedes the 8:30 PM schedule set by 202608130001 and re-applied by
-- 202608140003 and 202608160004. Idempotent: unschedule uses exception
-- guard, schedule replaces by jobname.

do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '1 2,3 * * 1',
  $$ select public.publish_and_update_schedule(); $$
);