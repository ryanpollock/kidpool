-- Widen the drive-reminder and status-reminder cron schedule to include :40
-- so that Wednesday 2:10 PM pickup reminders (12:40 PM drive, 1:40 PM status)
-- are covered. The :40 fire is a no-op on non-Wednesday days (no trip has
-- a meeting_time that produces a :40 reminder window on those days).

do $$
begin
  perform cron.unschedule('drive-reminder');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.unschedule('status-reminder');
exception when others then
  null;
end $$;

select cron.schedule(
  'drive-reminder',
  '0,25,40 * * * *',
  $$ select public.send_drive_reminders(); $$
);

select cron.schedule(
  'status-reminder',
  '0,25,40 * * * *',
  $$ select public.send_status_reminders(); $$
);