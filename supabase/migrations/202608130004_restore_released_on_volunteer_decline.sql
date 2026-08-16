-- Restore the original driver's assignment when a volunteer declines.
--
-- PROBLEM: When a driver declines and another parent volunteers via
-- volunteer_for_declined_drive, the original assignment is set to 'released'
-- (permanent) and riders are moved to the volunteer's new assignment. If the
-- volunteer then declines, the original driver is stuck:
--   - Their assignment is 'released' (can't re-accept, invisible in UI)
--   - The volunteer's assignment is 'declined' (has the riders)
--   - No confirmed/tentative driver exists for the trip
-- The original driver's only option is to volunteer for the declined drive
-- via the "I can drive" alert, which creates a third assignment — confusing
-- and doesn't match the user's mental model of "re-accept my drive."
--
-- FIX: When a 'confirmed' assignment is declined, check if there's a 'released'
-- assignment for the same trip + schedule_version. If found AND no other
-- confirmed/tentative driver exists for the trip, restore the 'released'
-- assignment back to 'declined' and move the riders back. The original driver
-- then sees it in "Cancelled or missed drives" and can re-accept normally.
--
-- Also includes a one-time data fix for any existing broken assignments.
--
-- Idempotent: uses CREATE OR REPLACE. Safe to re-run.

-- ── 1. Rewrite respond_to_driver_assignment with restore logic ──

create or replace function public.respond_to_driver_assignment(
  target_assignment_id uuid,
  driver_response public.confirmation_response,
  decline_reason text default null
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment public.driver_assignments;
  v_rider_count integer;
  v_released_assignment public.driver_assignments;
  v_other_active_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into assignment
  from public.driver_assignments
  where id = target_assignment_id
  for update;

  if assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  if assignment.driver_profile_id <> auth.uid() then
    raise exception 'Only the assigned driver can respond';
  end if;

  -- Guard: only allow re-response when the assignment is still actionable.
  -- 'tentative'/'confirmed'/'declined'/'expired' may be re-responded.
  -- 'released' (a volunteer took over a declined drive) is final and
  -- cannot be resurrected.
  if assignment.status not in ('tentative', 'confirmed', 'declined', 'expired') then
    raise exception 'This assignment can no longer be responded to (status: %)', assignment.status;
  end if;

  -- Guard for expired: a rider family may have already taken over via
  -- volunteer_for_uncovered_trip (expired kids are genuinely uncovered
  -- from the server's perspective). If the rider rows have been moved
  -- away, re-accept would resurrect a zero-rider confirmed assignment.
  -- Block that with a clear message.
  if assignment.status = 'expired' then
    select count(*) into v_rider_count
    from public.rider_assignments
    where driver_assignment_id = assignment.id;

    if v_rider_count = 0 then
      raise exception 'Another driver has already taken this drive';
    end if;
  end if;

  -- Upsert the confirmation row (unique on driver_assignment_id).
  -- This allows changing a prior response.
  insert into public.driver_confirmations (
    group_id,
    driver_assignment_id,
    driver_profile_id,
    response,
    decline_reason
  )
  values (
    assignment.group_id,
    assignment.id,
    auth.uid(),
    driver_response,
    case
      when driver_response = 'declined' and decline_reason is not null
        then left(trim(decline_reason), 500)
      else null
    end
  )
  on conflict (driver_assignment_id)
  do update set
    response = excluded.response,
    decline_reason = excluded.decline_reason,
    responded_at = now();

  update public.driver_assignments
  set status = case
    when driver_response = 'confirmed' then 'confirmed'::public.assignment_status
    else 'declined'::public.assignment_status
  end
  where id = assignment.id
  returning * into assignment;

  -- ── Restore the original driver's assignment when a volunteer declines ──
  -- When a 'confirmed' assignment (typically a volunteer who took over) is
  -- declined, check if there's a 'released' assignment for the same trip +
  -- schedule version (the original driver's assignment). If found AND no
  -- other confirmed/tentative driver exists for this trip, move the riders
  -- back and restore the 'released' assignment to 'declined' so the original
  -- driver can re-accept from the Home screen.
  if driver_response = 'declined' then
    select *
    into v_released_assignment
    from public.driver_assignments
    where schedule_version_id = assignment.schedule_version_id
      and trip_id = assignment.trip_id
      and status = 'released'
      and driver_profile_id <> auth.uid()
    order by updated_at desc
    limit 1
    for update;

    if v_released_assignment.id is not null then
      -- Check that no other confirmed/tentative driver exists for this trip
      -- (excluding the assignment that was just declined). If someone else
      -- already took over, don't restore — the trip is covered.
      select count(*) into v_other_active_count
      from public.driver_assignments
      where schedule_version_id = assignment.schedule_version_id
        and trip_id = assignment.trip_id
        and status in ('tentative', 'confirmed')
        and id <> assignment.id;

      if v_other_active_count = 0 then
        -- Move riders back to the original assignment
        update public.rider_assignments
        set driver_assignment_id = v_released_assignment.id
        where driver_assignment_id = assignment.id;

        -- Restore the original assignment to 'declined' so the original
        -- driver can re-accept it from the Home screen.
        update public.driver_assignments
        set status = 'declined'
        where id = v_released_assignment.id;

        -- Audit the restoration
        insert into public.audit_events (
          group_id, actor_profile_id, action, entity_type, entity_id, details
        )
        values (
          assignment.group_id, auth.uid(), 'released_assignment_restored', 'driver_assignment',
          v_released_assignment.id::text,
          jsonb_build_object(
            'restored_assignment_id', v_released_assignment.id,
            'declined_assignment_id', assignment.id,
            'trip_id', assignment.trip_id,
            'reason', 'volunteer declined, no other active driver'
          )
        );
      end if;
    end if;
  end if;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    assignment.group_id, auth.uid(), 'driver_assignment_responded', 'driver_assignment',
    assignment.id::text,
    jsonb_build_object(
      'response', driver_response,
      'decline_reason',
        case
          when driver_response = 'declined' and decline_reason is not null
            then left(trim(decline_reason), 500)
          else null
        end
    )
  );

  return assignment;
end;
$$;

revoke all on function public.respond_to_driver_assignment(uuid, public.confirmation_response, text) from public;
grant execute on function public.respond_to_driver_assignment(uuid, public.confirmation_response, text) to authenticated;

-- ── 2. One-time data fix for existing broken assignments ──────
-- Find 'released' assignments that have a corresponding 'declined' assignment
-- for the same trip + schedule version, where no confirmed/tentative driver
-- exists. Move riders back and restore the released assignment to 'declined'.
-- This is safe to run multiple times — the WHERE clauses ensure it only
-- touches rows that match the broken pattern.

do $$
declare
  r record;
  v_active_count integer;
  v_restored integer := 0;
begin
  for r in
    select da_released.id as released_id,
           da_declined.id as declined_id,
           da_released.trip_id,
           da_released.schedule_version_id,
           da_released.group_id
    from public.driver_assignments da_released
    join public.driver_assignments da_declined
      on da_declined.schedule_version_id = da_released.schedule_version_id
     and da_declined.trip_id = da_released.trip_id
     and da_declined.driver_profile_id <> da_released.driver_profile_id
    where da_released.status = 'released'
      and da_declined.status = 'declined'
      and da_released.driver_profile_id <> da_declined.driver_profile_id
  loop
    -- Check no other confirmed/tentative driver for this trip
    select count(*) into v_active_count
    from public.driver_assignments
    where schedule_version_id = r.schedule_version_id
      and trip_id = r.trip_id
      and status in ('tentative', 'confirmed');

    if v_active_count = 0 then
      -- Move riders from the declined assignment back to the released one
      update public.rider_assignments
      set driver_assignment_id = r.released_id
      where driver_assignment_id = r.declined_id;

      -- Restore the released assignment to 'declined'
      update public.driver_assignments
      set status = 'declined'
      where id = r.released_id;

      insert into public.audit_events (
        group_id, actor_profile_id, action, entity_type, entity_id, details
      )
      values (
        r.group_id,
        (select driver_profile_id from public.driver_assignments where id = r.released_id),
        'released_assignment_restored', 'driver_assignment',
        r.released_id::text,
        jsonb_build_object(
          'restored_assignment_id', r.released_id,
          'declined_assignment_id', r.declined_id,
          'trip_id', r.trip_id,
          'reason', 'one-time data fix: volunteer declined, no active driver'
        )
      );

      v_restored := v_restored + 1;
    end if;
  end loop;

  raise notice 'Restored % released assignment(s) to declined', v_restored;
end $$;