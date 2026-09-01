-- Fix the drive-reminder and status-reminder cron schedule.
--
-- 202609010002_widen_reminder_cron.sql rescheduled BOTH crons to
-- '0,25,40 * * * *' to cover Wednesday's 2:10 PM early dismissal (whose
-- reminders land on :40). That REPLACED the prior per-cron schedules
-- (drive-reminder '0,25', status-reminder '10,45') and silently dropped
-- the :10 and :45 fires that the normal school day depends on. The drive
-- lead time also moved 75 -> 90 min, shifting the morning drive reminder
-- from :25 to :10. Net effect: every drive/status reminder no-op'd except
-- Wednesday's. The Edge Function still ran (cron.job_run_details = succeeded)
-- but returned 'outside_window' because the reminder minute never matched a
-- cron fire minute.
--
-- Reminder minutes across every trip meeting_time in the schedule:
--   morning  08:40 -> status 08:10 (:10), drive 07:10 (:10)
--   pm_early 14:10 -> status 13:40 (:40), drive 12:40 (:40)  (Wed early dismissal)
--   pm_early 16:20 -> status 15:50 (:50), drive 14:50 (:50)
--   pm_late  17:15 -> status 16:45 (:45), drive 15:45 (:45)
--
-- The Edge Function gate is pacificMinute in [rm, rm+5), so the cron fire
-- minute must equal the reminder minute. '10,40,45,50 * * * *' covers all
-- four cases. :00 and :25 produce no sends for any current trip and are
-- dropped. If meeting_times change, add the new reminder minute here (or
-- switch to '*/5 * * * *' for a future-proof but higher-fire alternative).

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
  '10,40,45,50 * * * *',
  $$ select public.send_drive_reminders(); $$
);

select cron.schedule(
  'status-reminder',
  '10,40,45,50 * * * *',
  $$ select public.send_status_reminders(); $$
);