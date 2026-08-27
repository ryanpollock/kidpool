-- Fix cancel_ride_for_child and cancel_ride_for_child_by_coordinator:
--
-- 1. Remove the published-only guard so removals work on both published
--    and draft schedule versions. The drive detail screen may find an
--    assignment from a draft version (v3) via the homeSchedule search.
--    The published-only guard rejected it silently, making the remove
--    button appear broken.
--
-- 2. Set ride_requests.needs_ride = false when removing a child from a
--    drive. Previously the rider_assignment was deleted but the ride
--    request still said needs_ride=true, causing the app to show
--    "needs a ride" for a trip the parent just opted out of.

-- ── 1. cancel_ride_for_child ─────────────────────────────────
create or replace function public.cancel_ride_for_child(
  p_child_id uuid,
  p_driver_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_child public.children;
  v_assignment public.driver_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load the child and verify household membership
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  if not public.is_household_member(v_child.household_id) then
    raise exception 'You can only cancel rides for your own children';
  end if;

  -- Load the driver assignment
  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  -- Delete the rider_assignment row
  delete from public.rider_assignments
  where child_id = p_child_id
    and driver_assignment_id = p_driver_assignment_id;

  if not found then
    raise exception 'Ride not found for this child on this trip';
  end if;

  -- Mark the ride request as not needed for this trip
  update public.ride_requests
  set needs_ride = false
  where child_id = p_child_id
    and trip_id = v_assignment.trip_id;

  -- Record audit event
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_child.group_id, auth.uid(), 'ride_cancelled', 'rider_assignment',
    p_driver_assignment_id::text,
    jsonb_build_object(
      'child_id', p_child_id,
      'child_name', v_child.first_name || ' ' || v_child.last_name,
      'trip_id', v_assignment.trip_id,
      'driver_assignment_id', p_driver_assignment_id
    )
  );
end;
$$;

revoke all on function public.cancel_ride_for_child(uuid, uuid) from public, authenticated;
grant execute on function public.cancel_ride_for_child(uuid, uuid) to authenticated;

-- ── 2. cancel_ride_for_child_by_coordinator ──────────────────
create or replace function public.cancel_ride_for_child_by_coordinator(
  p_child_id uuid,
  p_driver_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_child public.children;
  v_assignment public.driver_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load the child
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  -- Verify the caller is a coordinator for the child's group
  if not public.is_group_coordinator(auth.uid(), v_child.group_id) then
    raise exception 'Only coordinators can remove other children from drives';
  end if;

  -- Load the driver assignment
  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  -- Delete the rider_assignment row
  delete from public.rider_assignments
  where child_id = p_child_id
    and driver_assignment_id = p_driver_assignment_id;

  if not found then
    raise exception 'Ride not found for this child on this trip';
  end if;

  -- Mark the ride request as not needed for this trip
  update public.ride_requests
  set needs_ride = false
  where child_id = p_child_id
    and trip_id = v_assignment.trip_id;

  -- Record audit event
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_child.group_id, auth.uid(), 'ride_cancelled_by_coordinator', 'rider_assignment',
    p_driver_assignment_id::text,
    jsonb_build_object(
      'child_id', p_child_id,
      'child_name', v_child.first_name || ' ' || v_child.last_name,
      'trip_id', v_assignment.trip_id,
      'driver_assignment_id', p_driver_assignment_id
    )
  );
end;
$$;

revoke all on function public.cancel_ride_for_child_by_coordinator(uuid, uuid) from public, authenticated;
grant execute on function public.cancel_ride_for_child_by_coordinator(uuid, uuid) to authenticated;