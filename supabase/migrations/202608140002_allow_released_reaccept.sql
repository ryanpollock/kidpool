-- Allow re-accepting a 'released' assignment with rider transfer.
--
-- PROBLEM: When a driver cancels and another parent volunteers via
-- volunteer_for_declined_drive, the original assignment is set to 'released'
-- (permanent) and riders move to the volunteer. If the volunteer then cancels,
-- the original driver is stuck — their assignment is 'released' (can't
-- re-accept) and the volunteer's is 'declined' (has the riders). The original
-- driver's only option is "I can drive" which creates a third assignment.
-- This makes the back-and-forth toggle (cancel/volunteer/cancel/re-accept)
-- impossible, which is what users expect.
--
-- FIX: Allow 'released' assignments to be re-accepted:
--   1. Add 'released' to the allowed statuses in respond_to_driver_assignment
--   2. When confirming a 'released' assignment:
--      a. Find a 'declined'/'expired' assignment for the same trip + version
--         that has riders
--      b. Guard: no other confirmed/tentative driver exists for this trip
--      c. Move riders from the declined/expired assignment to this one
--      d. Set this assignment to 'confirmed'
--   3. Extend the 0-rider guard from 'expired' to also cover 'declined':
--      prevents re-accepting a 0-rider 'declined' (riders have been moved
--      to a 'released' assignment that the driver should re-accept instead)
--
-- Idempotent: uses CREATE OR REPLACE. Safe to re-run.

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
  v_other_assignment public.driver_assignments;
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

  -- Guard: allow re-response for tentative, confirmed, declined, expired,
  -- AND released. 'released' means a volunteer took over a declined drive,
  -- but the volunteer may have also declined — the original driver can now
  -- take it back.
  if assignment.status not in ('tentative', 'confirmed', 'declined', 'expired', 'released') then
    raise exception 'This assignment can no longer be responded to (status: %)', assignment.status;
  end if;

  -- Guard for expired AND declined: a rider family may have already taken
  -- over via volunteer_for_uncovered_trip or the riders may have been moved
  -- to a released assignment. If the rider rows have been moved away,
  -- re-accept would resurrect a zero-rider assignment. Block that — the
  -- driver should re-accept the assignment that actually has the riders
  -- (which may be a 'released' assignment in the same trip).
  if assignment.status in ('expired', 'declined') then
    select count(*) into v_rider_count
    from public.rider_assignments
    where driver_assignment_id = assignment.id;

    if v_rider_count = 0 then
      raise exception 'Another driver has already taken this drive';
    end if;
  end if;

  -- Guard for released: if this assignment was taken over by a volunteer
  -- (who created a new confirmed assignment), block re-accept if the
  -- volunteer is still confirmed/tentative (the trip is covered).
  -- If the volunteer also declined (no confirmed/tentative driver), allow
  -- re-accept and move riders back.
  if assignment.status = 'released' then
    select count(*) into v_other_active_count
    from public.driver_assignments
    where schedule_version_id = assignment.schedule_version_id
      and trip_id = assignment.trip_id
      and status in ('tentative', 'confirmed')
      and id <> assignment.id;

    if v_other_active_count > 0 then
      raise exception 'Another driver has already taken this drive';
    end if;
  end if;

  -- Upsert the confirmation row (unique on driver_assignment_id).
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

  -- ── Rider transfer on released re-accept ──────────────────
  -- When a 'released' assignment is confirmed, move riders from the
  -- declined/expired assignment that currently holds them back to this
  -- assignment. This restores the original driver's riders.
  if driver_response = 'confirmed' and assignment.status = 'confirmed' then
    select *
    into v_other_assignment
    from public.driver_assignments
    where schedule_version_id = assignment.schedule_version_id
      and trip_id = assignment.trip_id
      and status in ('declined', 'expired')
      and id <> assignment.id
      and (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = driver_assignments.id) > 0
    order by updated_at desc
    limit 1
    for update;

    if v_other_assignment.id is not null then
      update public.rider_assignments
      set driver_assignment_id = assignment.id
      where driver_assignment_id = v_other_assignment.id;

      insert into public.audit_events (
        group_id, actor_profile_id, action, entity_type, entity_id, details
      )
      values (
        assignment.group_id, auth.uid(), 'riders_transferred', 'driver_assignment',
        assignment.id::text,
        jsonb_build_object(
          'from_assignment_id', v_other_assignment.id,
          'to_assignment_id', assignment.id,
          'trip_id', assignment.trip_id,
          'reason', 'released re-accept: riders moved back to original driver'
        )
      );
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