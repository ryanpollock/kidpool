-- Move draft schedule generation from Saturday afternoon to Sunday 7 AM Pacific.
-- Check-in deadline moves from Saturday 3 PM to Saturday midnight (11:59 PM).
-- This gives families all of Saturday to check in, generates the draft Sunday
-- morning so parents wake up to confirmation requests, and gives drivers all
-- day Sunday to confirm before the 7 PM confirmation deadline.
--
-- Cron: 14:00 UTC = 7 AM PDT / 6 AM PST (both Sunday morning, acceptable)

do $$
begin
  perform cron.unschedule('generate-schedule-saturday');
exception when others then
  null;
end $$;

select cron.schedule(
  'generate-schedule-sunday-morning',
  '0 14 * * 0',
  $$ select public.generate_schedule_cron(); $$
);

-- Backfill existing weeks: move check-in deadline from 3 PM to midnight Pacific
update public.weeks
set checkin_deadline = ((starts_on - 2)::text || ' 23:59:00')::timestamp at time zone 'America/Los_Angeles'
where starts_on is not null
  and checkin_deadline is not null;