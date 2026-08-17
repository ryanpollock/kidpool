-- Move the Sunday auto-publish from 8:45 PM Pacific to 9:30 PM Pacific.
--
-- 9:30 PM PDT = 04:30 UTC  → 30 4,5 * * 1
-- 9:30 PM PST = 05:30 UTC  → (same cron, off-DST fire deduped by idempotent
--   publish — the second fire is a no-op once the week is already published)
--
-- Keeps the surgical wrapper from 20260816004 (publish_and_update_schedule).
-- After publish, generate-schedule invokes send-push with type "published",
-- which sends the full week's schedule email to all active members.
--
-- Supersedes the 8:45 PM schedule set by 202608160006. Idempotent:
-- unschedule uses exception guard, schedule replaces by jobname.

do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '30 4,5 * * 1',
  $$ select public.publish_and_update_schedule(); $$
);