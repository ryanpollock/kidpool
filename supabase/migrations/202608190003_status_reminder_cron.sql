-- Status reminder: send a 30-minute pre-drive push notification prompting
-- drivers to tap "I'm on my way" and (morning only) rider parents to tap
-- "Mark ready". Fires at 30 minutes before the morning (8:40 AM) and
-- afternoon (5:15 PM) drive times, in Pacific time.
--
-- 30 min before 8:40 AM = 8:10 AM Pacific
-- 30 min before 5:15 PM = 4:45 PM Pacific
--
-- The cron fires at :10 and :45 every hour. The send-push status_reminder
-- type self-gates to the exact Pacific minute (8:10 AM / 4:45 PM), so only
-- 2 of the 48 daily fires actually send. All other fires do one cheap time
-- check and return — zero DB queries, zero push calls.
--
-- Afternoon rider parents get NO notification (kids are at school together,
-- no "at the curb" status needed). The edge function handles this logic.
--
-- Same vault pattern as send_drive_reminders.

create or replace function public.send_status_reminders()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return;
  end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets
  where name = 'cron_edge_base_url'
  limit 1;

  if v_base_url is null then
    raise notice 'No cron_edge_base_url found in vault';
    return;
  end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('type', 'status_reminder')
  );
end;
$$;

revoke all on function public.send_status_reminders() from public, authenticated;

-- Fire at :10 and :45 every hour. The Edge Function gates to the exact
-- Pacific hour+minute (8:10 AM for morning, 4:45 PM for afternoon), so
-- only 2 of the 48 daily fires actually send.
select cron.schedule(
  'status-reminder',
  '10,45 * * * *',
  $$ select public.send_status_reminders(); $$
);