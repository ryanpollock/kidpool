-- Fix the pg_net timeout for send_backpack_sheet (same bug as all other
-- wrapper functions — net.http_post defaults to 5s, the backpack sheet
-- makes multiple DB queries + Resend API calls that take longer).
--
-- Also: the backpack sheet now includes kid phone numbers for carmates.
-- The Edge Function change handles this; the migration only fixes the timeout.
--
-- Idempotent: CREATE OR REPLACE. Safe to re-run.

create or replace function public.send_backpack_sheet()
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
    body := jsonb_build_object('type', 'backpack_sheet'),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.send_backpack_sheet() from public, authenticated;