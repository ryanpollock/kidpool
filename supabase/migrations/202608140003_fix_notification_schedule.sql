-- Replace hourly reminder crons with 5 fixed-time crons.
--
-- PROBLEM: The checkin-deadline-reminder and confirmation-deadline-reminder
-- crons fired every hour with no time gate, sending push notifications at
-- 3am, 4am, 5am, etc. The email was deduped by date but the push was not.
--
-- FIX: Replace both hourly crons with 5 fixed-time crons that fire at
-- specific Pacific times, DST-proofed via dual UTC schedules. The off-DST
-- fire is deduped by the per-date idempotency key.
--
-- Check-in reminders (Saturday):
--   9 AM Pacific   = 16:00 UTC (PDT) / 17:00 UTC (PST)  → 0 16,17 * * 6
--   6 PM Pacific   = 01:00 UTC (PDT) / 02:00 UTC (PST)  → 0 1,2 * * 0
--   11 PM Pacific  = 06:00 UTC (PDT) / 07:00 UTC (PST)  → 0 6,7 * * 0
--
-- Confirmation reminders (Sunday):
--   8 AM Pacific   = 15:00 UTC (PDT) / 16:00 UTC (PST)  → 0 15,16 * * 0
--   7 PM Pacific   = 02:00 UTC (PDT) / 03:00 UTC (PST)  → 0 2,3 * * 1
--
-- Also fixes: generate-schedule-sunday was overwritten back to '0 3 * * 1'
-- by another migration. Re-applies the 8:30 PM Pacific schedule '30 3,4 * * 1'.
--
-- All wrapper functions use timeout_milliseconds := 120000 (the pg_net
-- fix from 202608130002/003 — the confirmation wrapper was missing it).
--
-- Idempotent: unschedule uses exception guard, schedule is idempotent
-- (pg_cron replaces by jobname).

-- ── 1. Unschedule the 2 hourly crons ─────────────────────────

do $$
begin
  perform cron.unschedule('checkin-deadline-reminder');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('confirmation-deadline-reminder');
exception when others then null;
end $$;

-- ── 2. Fix generate-schedule-sunday (re-apply 8:30 PM Pacific) ──

do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '30 3,4 * * 1',
  $$ select public.generate_schedule_cron(); $$
);

-- ── 3. Check-in reminder wrapper functions ───────────────────

create or replace function public.send_checkin_reminder_9am()
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
  from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_secret is null then return; end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;
  if v_base_url is null then return; end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'checkin_reminder',
      'title', 'Time to check in for next week',
      'body', 'Check in for next week — deadline Saturday midnight.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_checkin_reminder_9am() from public, authenticated;

create or replace function public.send_checkin_reminder_6pm()
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
  from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_secret is null then return; end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;
  if v_base_url is null then return; end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'checkin_reminder',
      'title', 'Check-in deadline tonight',
      'body', 'Submit your check-in by Saturday midnight.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_checkin_reminder_6pm() from public, authenticated;

create or replace function public.send_checkin_reminder_11pm()
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
  from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_secret is null then return; end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;
  if v_base_url is null then return; end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'checkin_reminder',
      'title', '1 hour left to check in',
      'body', 'Submit your check-in now — deadline in 1 hour.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_checkin_reminder_11pm() from public, authenticated;

-- ── 4. Confirmation reminder wrapper functions ──────────────

create or replace function public.send_confirmation_reminder_8am()
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
  from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_secret is null then return; end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;
  if v_base_url is null then return; end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'confirmation_reminder',
      'title', 'Confirm your drives',
      'body', 'You have drives to confirm by 8 PM tonight. Open the app to review.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_confirmation_reminder_8am() from public, authenticated;

create or replace function public.send_confirmation_reminder_7pm()
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
  from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_secret is null then return; end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;
  if v_base_url is null then return; end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'confirmation_reminder',
      'title', '1 hour left to confirm',
      'body', 'Confirm your drives now — deadline in 1 hour.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_confirmation_reminder_7pm() from public, authenticated;

-- ── 5. Schedule the 5 crons at fixed times ───────────────────

-- Check-in: Sat 9 AM Pacific = 16:00/17:00 UTC
select cron.schedule(
  'checkin-reminder-9am',
  '0 16,17 * * 6',
  $$ select public.send_checkin_reminder_9am(); $$
);

-- Check-in: Sat 6 PM Pacific = 01:00/02:00 UTC (Sunday in UTC)
select cron.schedule(
  'checkin-reminder-6pm',
  '0 1,2 * * 0',
  $$ select public.send_checkin_reminder_6pm(); $$
);

-- Check-in: Sat 11 PM Pacific = 06:00/07:00 UTC (Sunday in UTC)
select cron.schedule(
  'checkin-reminder-11pm',
  '0 6,7 * * 0',
  $$ select public.send_checkin_reminder_11pm(); $$
);

-- Confirmation: Sun 8 AM Pacific = 15:00/16:00 UTC
select cron.schedule(
  'confirmation-reminder-8am',
  '0 15,16 * * 0',
  $$ select public.send_confirmation_reminder_8am(); $$
);

-- Confirmation: Sun 7 PM Pacific = 02:00/03:00 UTC (Monday in UTC)
select cron.schedule(
  'confirmation-reminder-7pm',
  '0 2,3 * * 1',
  $$ select public.send_confirmation_reminder_7pm(); $$
);