-- Enable pg_cron and pg_net extensions for deadline reminders.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop the old cron schedule that used a non-existent GUC
do $$
begin
  perform cron.unschedule('checkin-deadline-reminder');
exception when others then
  null;
end $$;

-- Wrapper function that reads the cron secret from vault and calls the Edge Function.
create or replace function public.send_deadline_reminders()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return;
  end if;

  perform net.http_post(
    url := 'https://ujcrnrcgbvzyqosykkjy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('type', 'deadline_reminder')
  );
end;
$$;

-- Schedule hourly cron job
select cron.schedule(
  'checkin-deadline-reminder',
  '0 * * * *',
  $$ select public.send_deadline_reminders(); $$);