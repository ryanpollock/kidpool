-- Move the drive-reminder cron from 75 min to 90 min before pickup.
-- 90 min before 8:40 AM = 7:10 AM Pacific
-- 90 min before 5:15 PM = 3:45 PM Pacific
--
-- The cron fires at :10 and :45 every hour. The send-push drive_reminder
-- type self-gates to the exact Pacific minute (7:10 AM / 3:45 PM), so only
-- 2 of the 48 daily fires actually send. All other fires do one cheap time
-- check and return — zero DB queries, zero Resend calls.
-- (Previously fired at :00 and :25 for the 75-min timing.)

select cron.unschedule('drive-reminder');

select cron.schedule(
  'drive-reminder',
  '10,45 * * * *',
  $$ select public.send_drive_reminders(); $$
);