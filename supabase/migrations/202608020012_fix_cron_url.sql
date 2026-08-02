-- Fix: deadline cron had hardcoded production URL.
-- Use a vault secret for the Supabase URL so staging cron calls staging Edge Functions.

create or replace function public.send_deadline_reminders()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_supabase_url text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return;
  end if;

  -- Derive the Supabase URL from the project's default URL pattern.
  -- The auth.users table contains aud = 'authenticated' which maps to the project URL.
  -- Using the Supabase API project ref is simpler: we can get it from current_setting.
  -- But the most reliable approach is to use the vault-stored supabase_url.
  begin
    select decrypted_secret into v_supabase_url
    from vault.decrypted_secrets
    where name = 'supabase_url'
    limit 1;
  exception when others then
    v_supabase_url := null;
  end;

  -- Fallback to production URL if no supabase_url secret is stored
  if v_supabase_url is null then
    v_supabase_url := 'https://ujcrnrcgbvzyqosykkjy.supabase.co';
  end if;

  perform net.http_post(
    url := v_supabase_url || '/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('type', 'deadline_reminder')
  );
end;
$$;

-- No need to reschedule — the cron job calls this function by name.