-- Move the Sunday auto-publish from 9:30 PM Pacific to 7:15 PM Pacific.
--
-- 7:15 PM PDT = 02:15 UTC  → 15 2,3 * * 1
-- 7:15 PM PST = 03:15 UTC  → (same cron, off-DST fire deduped by idempotent
--   publish — the second fire is a no-op once the week is already published)
--
-- 7:15 PM is 15 minutes after the 7 PM confirmation deadline, giving a buffer
-- for last-second confirmations to land before the surgical pass reads state.
--
-- Keeps the surgical wrapper from 20260816004 (publish_and_update_schedule).
-- After publish, generate-schedule invokes send-push with type "published",
-- which sends the full week's schedule email to all active members.
--
-- Supersedes the 9:30 PM schedule set by 202608160008. Idempotent:
-- unschedule uses exception guard, schedule replaces by jobname.

do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '15 2,3 * * 1',
  $$ select public.publish_and_update_schedule(); $$
);