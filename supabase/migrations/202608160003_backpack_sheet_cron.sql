-- Backpack sheet email: send a per-child "backpack sheet" to families
-- at 7 AM Pacific every school day (Mon–Fri). Each family with a child
-- riding today gets an email with per-child sections showing the
-- driver name + phone (drive-scoped, always shown), vehicle, other kids
-- in the car, and pickup time/origin for morning + afternoon. Designed
-- to be printed and put in the kid's backpack. Email-only.
--
-- The Edge Function self-gates: if no trips exist for today (holiday,
-- weekend), it no-ops and returns "no_school_today". DST-proofed via
-- dual UTC fire (0 14,15 * * 1-5): one fire is 7 AM PDT (UTC-7), the
-- other is 7 AM PST (UTC-8). The off-DST fire is deduped by the
-- send-push idempotency key (includes today's Pacific date + profile ID).
--
-- Uses cron_edge_base_url and cron_secret from vault — environment-aware,
-- same pattern as send_night_before_summary and send_coordinator_tentative_summary.

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
    body := jsonb_build_object('type', 'backpack_sheet')
  );
end;
$$;

revoke all on function public.send_backpack_sheet() from public, authenticated;

-- 7 AM Pacific Mon–Fri, DST-proofed dual UTC fire (14:00 and 15:00 UTC).
-- The off-DST fire dedupes via the send-push Idempotency-Key.
select cron.schedule(
  'backpack-sheet',
  '0 14,15 * * 1-5',
  $$ select public.send_backpack_sheet(); $$
);