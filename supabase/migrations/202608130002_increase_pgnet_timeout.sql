-- Increase the pg_net HTTP timeout from the default 5 seconds to 120 seconds
-- for all notification wrapper functions.
--
-- ROOT CAUSE: net.http_post defaults to timeout_milliseconds=5000 (5s). The
-- night_before_summary and drive_reminder Edge Function branches make multiple
-- PostgREST queries + Resend API calls that take longer than 5s. pg_net kills
-- the connection before the function finishes, and the Supabase Edge Functions
-- platform aborts the function when the client disconnects — so no emails or
-- pushes are ever sent. Cron runs show "succeeded" because net.http_post
-- returns immediately (it just queues the request); the timeout happens in
-- the background worker.
--
-- Evidence: net._http_response shows status_code=200 for all hourly fires
-- that return "outside_window" (instant), but status_code=NULL at 14:25 UTC
-- (7:25 AM PDT — the exact moment the drive_reminder gate passes and the
-- function does real work). The night-before at 03:00 UTC (8 PM PDT) shows
-- the same pattern but the response was rotated out of the 5-hour retention
-- window.
--
-- This migration rewrites three wrapper functions to pass timeout_milliseconds
-- := 120000 (2 minutes):
--   1. send_night_before_summary() — the "Tomorrow's carpool" email
--   2. send_drive_reminders() — the 75-min pre-drive push + email
--   3. generate_schedule_cron() — schedule generation + auto-publish
--
-- Idempotent: uses CREATE OR REPLACE. Safe to re-run.

-- ── 1. send_night_before_summary ──────────────────────────────

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
    body := jsonb_build_object('type', 'night_before_summary'),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_night_before_summary() from public, authenticated;

-- ── 2. send_drive_reminders ───────────────────────────────────

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
    body := jsonb_build_object('type', 'drive_reminder'),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_drive_reminders() from public, authenticated;

-- ── 3. generate_schedule_cron ─────────────────────────────────

create or replace function public.generate_schedule_cron()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_week record;
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

  for v_week in
    select distinct on (w.group_id) w.id as week_id, w.group_id
    from public.weeks w
    where w.starts_on > (now() at time zone 'America/Los_Angeles')::date
      and exists (select 1 from public.trips t where t.week_id = w.id)
    order by w.group_id, w.starts_on asc
  loop
    perform net.http_post(
      url := v_base_url || '/generate-schedule',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object('weekId', v_week.week_id, 'source', 'cron'),
      timeout_milliseconds := 120000
    );
  end loop;
end;
$$;

revoke all on function public.generate_schedule_cron() from public, authenticated;