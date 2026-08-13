-- Reschedule the Sunday auto-publish cron so it fires at 8:30 PM Pacific,
-- ~30 minutes after the 8 PM Pacific confirmation deadline — early enough
-- that the night-before summary email (now gated to 9–10 PM Pacific, see
-- send-push) finds a published schedule for Monday's trips.
--
-- The original schedule ('0 5 * * 1' = Mon 05:00 UTC) landed at 10 PM PDT /
-- 9 PM PST — too late: the night-before summary already gated itself off at
-- 8 PM Pacific, so Monday's "Tomorrow's carpool" email was skipped every week.
--
-- New schedule: '30 3,4 * * 1' fires Mon 03:30 and 04:30 UTC.
--   Mon 03:30 UTC = Sun 8:30 PM PDT  (first fire, after the 8 PM PDT deadline)
--   Mon 04:30 UTC = Sun 8:30 PM PST  (first fire, after the 8 PM PST deadline)
-- Both fire every week, but generate_schedule_cron self-gates: it only
-- publishes when the week's confirmation_deadline has passed AND no prior
-- published version exists (deadlineAutoPublish in generate-schedule). So
-- the off-DST fire is an idempotent no-op — same pattern the Edge Function
-- Pacific-hour gate already uses. Re-running on the same evening is also
-- deduped by Resend's Idempotency-Key on the published-notification email.
--
-- The Saturday draft cron ('0 23 * * 6') is unchanged.

do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then
  null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '30 3,4 * * 1',
  $$ select public.generate_schedule_cron(); $$
);