-- Night-before summary email: send a "who's driving tomorrow" email to
-- families with a child riding tomorrow, at 8 PM Pacific the night before
-- each school day (Sun–Thu nights). Each email is personalized — the
-- recipient's own driving status is highlighted, followed by the full
-- driver roster with kids in each car.
--
-- The cron fires hourly. The send-push night_before_summary type self-gates
-- to 8 PM Pacific (America/Los_Angeles) and no-ops outside that hour, so
-- the UTC schedule does not need DST adjustment. The email idempotency
-- key includes tomorrow's Pacific date so a re-fire within the same
-- evening dedupes via Resend.
--
-- Uses cron_edge_base_url and cron_secret from vault — environment-aware,
-- same pattern as generate_schedule_cron and send_deadline_reminders.

create or replace function public.send_night_before_summary()
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
    body := jsonb_build_object('type', 'night_before_summary')
  );
end;
$$;

revoke all on function public.send_night_before_summary() from public, authenticated;

-- Hourly cron; the Edge Function gates to 8 PM Pacific so only one fire
-- per evening sends. pg_cron schedules in UTC (cron.timezone = GMT), but
-- the hourly cadence + Edge Function Pacific-hour gate is DST-proof.
select cron.schedule(
  'night-before-summary',
  '0 * * * *',
  $$ select public.send_night_before_summary(); $$
);