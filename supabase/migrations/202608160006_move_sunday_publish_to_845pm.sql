-- Move the Sunday auto-publish from 7:01 PM Pacific to 8:45 PM Pacific.
--
-- 8:45 PM PDT = 03:45 UTC  → 45 3,4 * * 1
-- 8:45 PM PST = 04:45 UTC  → (same cron, off-DST fire deduped by idempotent
--   publish — the second fire is a no-op once the week is already published)
--
-- The auto-publish requires the confirmation deadline to have passed
-- (deadlinePassed = true). At 8:45 PM the deadline (7 PM) has passed by
-- 1h45m, so publish_and_update_schedule fires and the schedule publishes
-- immediately.
--
-- Keeps the surgical wrapper from 202608160004 (publish_and_update_schedule),
-- which preserves confirmed driver assignments and only fits new riders
-- (from late check-ins) into spare car capacity. Does NOT call the full
-- regeneration wrapper, which would reshuffle confirmed drives and
-- regress PR #126.
--
-- After publish, the generate-schedule Edge Function invokes send-push
-- with type "published" — which sends the full week's schedule email
-- (driver + kids per car, per day) to all active members, plus a generic
-- push notification ("Schedule published — open the app").
--
-- Supersedes the 7:01 PM schedule set by 202608160005. Idempotent:
-- unschedule uses exception guard, schedule replaces by jobname.

do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '45 3,4 * * 1',
  $$ select public.publish_and_update_schedule(); $$
);