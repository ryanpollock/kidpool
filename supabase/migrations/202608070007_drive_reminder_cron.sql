-- Drive reminder: send a 75-minute pre-drive email + push notification to
-- confirmed drivers, listing the kids in their car. Fires at 75 minutes
-- before the morning (8:40 AM) and afternoon (5:15 PM) drive times, in
-- Pacific time.
--
-- The cron fires at :00 and :25 every hour. The send-push drive_reminder
-- type self-gates to the exact Pacific minute:
--   7:25 AM Pacific  = 75 min before 8:40 AM morning pickup
--   4:00 PM Pacific  = 75 min before 5:15 PM afternoon pickup
-- pg_cron schedules in UTC (cron.timezone = GMT), but the minute-of-hour
-- is preserved across UTC↔Pacific conversion, so firing at :25 every
-- hour hits 7:25 AM Pacific in both PDT and PST. The Edge Function's
-- Pacific-hour gate makes it DST-proof.
--
-- Idempotency key is per-trip-per-driver so a re-fire within the same
-- 5-minute window dedupes via Resend.
--
-- Uses cron_edge_base_url and cron_secret from vault — environment-aware,
-- same pattern as generate_schedule_cron and send_deadline_reminders.

create or replace function public.send_drive_reminders()
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
    body := jsonb_build_object('type', 'drive_reminder')
  );
end;
$$;

revoke all on function public.send_drive_reminders() from public, authenticated;

-- Fire at :00 and :25 every hour. The Edge Function gates to the exact
-- Pacific hour+minute (7:25 AM for morning, 4:00 PM for afternoon), so
-- only 2 of the 48 daily fires actually send. All other fires do one
-- cheap time check and return — zero DB queries, zero Resend calls.
select cron.schedule(
  'drive-reminder',
  '0,25 * * * *',
  $$ select public.send_drive_reminders(); $$
);