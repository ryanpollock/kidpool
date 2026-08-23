-- Fix confirmation reminder timing and content.
--
-- Three problems:
-- 1. The 8 AM reminder says "by 8 PM" but the actual deadline is 7 PM.
-- 2. The "final" reminder fires AT 7 PM (the deadline), not before it.
-- 3. The "final" reminder says "1 hour left" when the deadline has passed.
--
-- Fix:
-- - 8 AM reminder: change "8 PM" to "7 PM" in the body text.
-- - Final reminder: move from 7 PM to 5 PM PDT (2 hours before deadline).
--   Change title/body to "Final reminder — confirm your drives" /
--   "Your drives need confirmation by 7 PM tonight."
--
-- Cron schedule '0 0,1 * * 1' fires at 00:00 and 01:00 UTC on Mondays.
-- 00:00 UTC Mon = 5 PM PDT Sun (DST), 01:00 UTC Mon = 5 PM PST Sun (non-DST).
-- The send-push function self-gates via per-date idempotency key dedup.

-- ── 1. Fix the 8 AM reminder body text ────────────────────────
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
      'body', 'You have drives to confirm by 7 PM tonight. Open the app to review.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_confirmation_reminder_8am() from public, authenticated;

-- ── 2. Fix the final reminder: new content + new time ────────
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
      'title', 'Final reminder — confirm your drives',
      'body', 'Your drives need confirmation by 7 PM tonight. Open the app now to confirm or decline.'
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_confirmation_reminder_7pm() from public, authenticated;

-- ── 3. Reschedule the final reminder from 7 PM to 5 PM ────────
do $$
begin
  perform cron.unschedule('confirmation-reminder-7pm');
end;
$$;

select cron.schedule(
  'confirmation-reminder-7pm',
  '0 0,1 * * 1',
  $$ select public.send_confirmation_reminder_7pm(); $$
);