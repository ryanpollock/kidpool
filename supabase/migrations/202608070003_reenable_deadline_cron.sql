-- Re-enable the deadline reminder cron, fixed.
--
-- The cron was disabled in 202608051700 because:
--   1. The send-push PostgREST filter bug caused false "your child doesn't
--      have a ride" pushes. That bug is now fixed (eq. prefix on all filters).
--   2. The function fell back to a hardcoded production URL if no supabase_url
--      vault secret was set, which would fire from staging against production.
--      This migration rewrites the function to use cron_edge_base_url — the
--      same vault secret the schedule automation crons use — so it is
--      environment-aware with no hardcoded fallback.
--
-- The cron fires hourly. The send-push deadline_reminder type self-filters to
-- weeks with checkin_deadline within the next 24 hours, and the email
-- idempotency key includes the date so a family gets at most one reminder
-- per day even if the cron fires multiple times.

create or replace function public.send_deadline_reminders()
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
    body := jsonb_build_object('type', 'deadline_reminder')
  );
end;
$$;

revoke all on function public.send_deadline_reminders() from public, authenticated;

-- Re-schedule the hourly cron (was unscheduled in 202608051700).
select cron.schedule(
  'checkin-deadline-reminder',
  '0 * * * *',
  $$ select public.send_deadline_reminders(); $$
);