-- Move the Sunday confirmation deadline from 8 PM to 7 PM Pacific so the
-- auto-publish email goes out by 8 PM Pacific (not 10 PM).
--
-- The cron fires at 03:00 UTC = 8 PM PDT / 7 PM PST, one hour after the
-- 7 PM Pacific confirmation deadline (02:00 UTC). This gives the Edge
-- Function enough time to detect the deadline has passed and auto-publish.
--
-- Changes:
--   1. Reschedule the Sunday cron from 05:00 UTC to 03:00 UTC
--   2. Backfill existing weeks' confirmation_deadline from 20:00 to 19:00 Pacific

-- 1. Reschedule the Sunday cron (job name: generate-schedule-sunday)
do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then
  null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '0 3 * * 1',
  $$ select public.generate_schedule_cron(); $$
);

-- 2. Backfill existing weeks: move confirmation_deadline from 8 PM to 7 PM Pacific
update public.weeks
set confirmation_deadline = ((starts_on - 1)::text || ' 19:00:00')::timestamp at time zone 'America/Los_Angeles'
where starts_on is not null
  and confirmation_deadline is not null;