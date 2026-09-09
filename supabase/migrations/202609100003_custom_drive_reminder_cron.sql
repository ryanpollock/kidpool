-- Widen the drive-reminder and status-reminder crons to every 5 minutes
-- so ad hoc custom drives at arbitrary times get their 90-min and 30-min
-- reminders.
--
-- 202609010003 pinned the cron to '10,40,45,50 * * * *' — exactly the
-- reminder minutes of the four standard meeting times. A custom drive at
-- e.g. 4:50 PM needs a :20 fire, which never happens: the Edge Function
-- runs but always returns 'outside_window'.
--
-- The send-push window gate is pacificMinute in [rm, rm+5), so any 5-wide
-- minute window contains exactly one '*/5' fire — arbitrary meeting times
-- now always land. Every other fire does one cheap time check and returns
-- (zero DB queries, zero sends), which is the alternative the original
-- migration's comment recommended.

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
  '*/5 * * * *',
  $$ select public.send_drive_reminders(); $$
);

select cron.schedule(
  'status-reminder',
  '*/5 * * * *',
  $$ select public.send_status_reminders(); $$
);