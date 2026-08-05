-- Expire unconfirmed tentative assignments past their confirmation deadline.
-- This makes the confirmation deadline real: a driver who hasn't confirmed
-- by Sunday 8 PM Pacific has their assignment flipped to 'expired', and the
-- trip becomes uncovered (since coverage counts only confirmed seats).
-- The coordinator can then resolve the uncovered trip (find a replacement
-- who confirms) and publish.
--
-- Runs every 15 minutes via pg_cron. Idempotent — only touches assignments
-- whose status is currently 'tentative' and whose deadline has passed.

create or replace function public.expire_unconfirmed_assignments()
returns table(
  expired_count integer,
  affected_trips text[]
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_expired integer := 0;
  v_trips text[] := ARRAY[]::text[];
  v_trip_id text;
begin
  -- Find tentative assignments whose week's confirmation_deadline has passed.
  -- Join through driver_assignments -> schedule_versions -> weeks.
  for v_trip_id in
    select distinct t.id::text
    from public.driver_assignments da
    join public.schedule_versions sv on sv.id = da.schedule_version_id
    join public.weeks w on w.id = sv.week_id
    join public.trips t on t.id = da.trip_id
    where da.status = 'tentative'
      and w.confirmation_deadline is not null
      and w.confirmation_deadline < now()
  loop
    v_trips := array_append(v_trips, v_trip_id);
  end loop;

  -- Expire them.
  update public.driver_assignments
  set status = 'expired', updated_at = now()
  where status = 'tentative'
    and schedule_version_id in (
      select sv.id
      from public.schedule_versions sv
      join public.weeks w on w.id = sv.week_id
      where w.confirmation_deadline is not null
        and w.confirmation_deadline < now()
    );

  get diagnostics v_expired = row_count;

  return query select v_expired, v_trips;
end;
$$;

-- Schedule the expiration job every 15 minutes.
-- Idempotent: unschedule first (ignore error if job doesn't exist), then schedule.
do $$
begin
  select cron.unschedule('expire-unconfirmed-assignments');
exception when others then
  null;
end $$;

select cron.schedule(
  'expire-unconfirmed-assignments',
  '*/15 * * * *',
  $$ select * from public.expire_unconfirmed_assignments(); $$
);