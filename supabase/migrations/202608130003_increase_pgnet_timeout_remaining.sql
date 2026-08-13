-- Increase the pg_net timeout from the default 5s to 120s for the two
-- remaining net.http_post callers that were missed by 202608130002:
--
--   1. send_deadline_reminders() — fires hourly via pg_cron. Queries weeks,
--      weekly_checkins, memberships, and profiles, then sends emails to
--      all unsubmitted households. Same multi-query + Resend pattern that
--      took >5s for the night-before summary.
--   2. send_welcome_email() — fires on AFTER INSERT on auth.users (new
--      signup). Sends a single welcome email via Resend — usually fast,
--      but if Resend is slow it could exceed the 5s default and silently
--      drop the welcome email for a new parent.
--
-- Idempotent: uses CREATE OR REPLACE. Safe to re-run.

-- ── 1. send_deadline_reminders ────────────────────────────────

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
    body := jsonb_build_object('type', 'deadline_reminder'),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_deadline_reminders() from public, authenticated;

-- ── 2. send_welcome_email ─────────────────────────────────────

create or replace function public.send_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_full_name text;
begin
  -- Only fire on genuine inserts, not updates.
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return new;
  end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets
  where name = 'cron_edge_base_url'
  limit 1;

  if v_base_url is null then
    raise notice 'No cron_edge_base_url found in vault';
    return new;
  end if;

  -- Derive the parent's name the same way handle_new_user does.
  v_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(coalesce(new.email, 'New parent'), '@', 1)
  );

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'welcome',
      'email', new.email,
      'full_name', v_full_name,
      'user_id', new.id
    ),
    timeout_milliseconds := 120000
  );

  return new;
end;
$$;

revoke all on function public.send_welcome_email() from public, authenticated;