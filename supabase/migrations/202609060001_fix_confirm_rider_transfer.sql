-- Fix: respond_to_driver_assignment rider transfer must only run on
-- released re-accepts — not every confirmation.
--
-- PRODUCTION BUG (Sun Sep 6, 2026): a driver with a FULL car (4/4 riders)
-- tried to confirm a tentative assignment and got 'Vehicle child-passenger
-- capacity exceeded'. Root cause: the rider-transfer block in
-- respond_to_driver_assignment was designed to move riders back from a
-- declined/expired assignment ONLY when re-accepting a 'released'
-- assignment (202608140002). But the gate condition reads
-- `assignment.status = 'confirmed'` AFTER the `update ... returning * into
-- assignment` — which overwrites the variable — so the gate is true on
-- EVERY confirmation. Any declined/expired sibling assignment holding
-- riders on the same trip gets its riders merged into the confirming
-- driver's car; when that car is full, the enforce_rider_assignment_capacity
-- trigger aborts the whole confirm.
--
-- FIX: capture the prior status BEFORE the update and gate the transfer on
-- v_prior_status = 'released' — restoring the intended behavior.
--
-- ALSO: carries forward the past-trip guard from a live-only staging hotfix
-- ('This trip has already happened') so it reaches production and the repo;
-- the two environments had diverged (staging's live def was based on a
-- pre-202608140002 body and had lost the released re-accept feature).
-- This migration reconciles both to one definition:
--   202608140002 body + past-trip guard + prior-status transfer gate.

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
  v_prior_status public.assignment_status;
  v_trip public.trips;
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

  -- Guard: block responses for past trips
  select * into v_trip from public.trips where id = assignment.trip_id;
  if v_trip.id is not null and v_trip.service_date < now()::date then
    raise exception 'This trip has already happened';
  end if;

  -- Guard: allow re-response for tentative, confirmed, declined, expired,
  -- AND released. 'released' means a volunteer took over a declined drive,
  -- but the volunteer may have also declined — the original driver can now
  -- take it back.
  if assignment.status not in ('tentative', 'confirmed', 'declined', 'expired', 'released') then
    raise exception 'This assignment can no longer be responded to (status: %)', assignment.status;
  end if;

  -- Capture the pre-response status BEFORE the update below overwrites the
  -- assignment variable — the rider transfer must only run for released
  -- re-accepts.
  v_prior_status := assignment.status;

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

  -- ── Rider transfer on released re-accept ONLY ───────────────
  -- When a 'released' assignment is confirmed, move riders from the
  -- declined/expired assignment that currently holds them back to this
  -- assignment. This restores the original driver's riders.
  -- Gated on v_prior_status (captured above) — a plain tentative/confirmed
  -- response must never merge another car's riders into the responder's.
  if driver_response = 'confirmed' and v_prior_status = 'released' and assignment.status = 'confirmed' then
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