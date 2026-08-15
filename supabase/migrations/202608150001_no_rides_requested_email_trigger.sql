-- Auto-email parents who submit a check-in with zero ride requests for their
-- active children. Fires on AFTER UPDATE of weekly_checkins when status
-- transitions to 'submitted'. If no active children have any
-- ride_requests with needs_ride=true, POSTs to send-push with
-- type='no_rides_requested' and checkin_id. The edge function handles
-- personalization (parent name, children names, week date) and sends the
-- email via Resend with an idempotency key of no-rides-${checkin_id}
-- (dedupes reopen/resubmit cycles).
--
-- Pattern mirrors the welcome email trigger (202608070004).
-- Includes timeout_milliseconds := 120000 (the pg_net fix the welcome
-- trigger predates).

create or replace function public.send_no_rides_requested_email()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_has_rides boolean;
  v_has_active_children boolean;
begin
  -- Only fire on genuine transitions to 'submitted' (not reopen→resubmit,
  -- not unrelated updates like max_drives changes).
  if new.status <> 'submitted' or (old.status = 'submitted') then
    return new;
  end if;

  -- Read vault secrets (fail soft like the welcome trigger).
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

  -- Check: does this household have any active children needing rides?
  select exists (
    select 1
    from public.ride_requests rr
    join public.children c on c.id = rr.child_id and c.group_id = rr.group_id
    where rr.checkin_id = new.id
      and c.active = true
      and rr.needs_ride = true
  ) into v_has_rides;

  -- Only email if the household has active children but none need rides.
  select exists (
    select 1
    from public.children c
    where c.household_id = new.household_id
      and c.group_id = new.group_id
      and c.active = true
  ) into v_has_active_children;

  if v_has_active_children and not v_has_rides then
    perform net.http_post(
      url := v_base_url || '/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object(
        'type', 'no_rides_requested',
        'checkin_id', new.id
      ),
      timeout_milliseconds := 120000
    );
  end if;

  return new;
end;
$$;

revoke all on function public.send_no_rides_requested_email() from public, authenticated;

create trigger on_checkin_submitted_no_rides
after update on public.weekly_checkins
for each row execute function public.send_no_rides_requested_email();