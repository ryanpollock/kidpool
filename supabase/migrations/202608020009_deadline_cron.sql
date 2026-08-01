-- Enable pg_cron and pg_net extensions for deadline reminders.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Schedule hourly cron job to check check-in deadlines and trigger push reminders.
select cron.schedule(
  'checkin-deadline-reminder',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://ujcrnrcgbvzyqosykkjy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := jsonb_build_object('type', 'deadline_reminder')
  );
  $$);