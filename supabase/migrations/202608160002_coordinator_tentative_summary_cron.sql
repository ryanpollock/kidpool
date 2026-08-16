-- Sunday morning coordinator email: send the tentative weekly schedule
-- to coordinators at 7 AM Pacific every Sunday, so they can review the
-- draft and nudge parents to confirm their drives before the 7 PM Pacific
-- confirmation deadline.
--
-- The email includes the full per-trip roster (tentative + confirmed
-- drivers, kids in each car), uncovered trips flagged, and households
-- that haven't submitted check-ins. Email-only (no push).
--
-- DST-proofed via dual UTC fire (0 14,15 * * 0): one fire is 7 AM PDT
-- (UTC-7), the other is 7 AM PST (UTC-8). The off-DST fire is deduped
-- by the send-push idempotency key (includes today's Pacific date +
-- week ID + coordinator profile ID).
--
-- Uses cron_edge_base_url and cron_secret from vault — environment-aware,
-- same pattern as send_night_before_summary and generate_schedule_cron.

create or replace function public.send_coordinator_tentative_summary()
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
    body := jsonb_build_object('type', 'coordinator_tentative_summary')
  );
end;
$$;

revoke all on function public.send_coordinator_tentative_summary() from public, authenticated;

-- Sunday 7 AM Pacific, DST-proofed dual UTC fire (14:00 and 15:00 UTC).
-- The off-DST fire dedupes via the send-push Idempotency-Key.
select cron.schedule(
  'coordinator-tentative-summary',
  '0 14,15 * * 0',
  $$ select public.send_coordinator_tentative_summary(); $$
);