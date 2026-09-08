-- Allow a parent to switch their child between the two afternoon drive times
-- (pm_early and pm_late) on the same day, directly from the drive details page.
--
-- The RPC atomically:
--   1. Verifies the caller is the child's parent (household member)
--   2. Finds the sibling afternoon trip for the same service_date
--   3. Finds the driver_assignment with the most available capacity on the sibling trip
--   4. Deletes the old rider_assignment, inserts a new one on the destination
--   5. Updates ride_requests: old trip needs_ride=false, new trip needs_ride=true
--   6. Writes an audit event
--
-- Returns: jsonb with new_driver_assignment_id, new_trip_id, old_driver_assignment_id,
-- old_trip_id, child_id — enough for the client to fire notifications.

create or replace function public.switch_child_afternoon_trip(
  p_child_id uuid,
  p_driver_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_child public.children;
  v_old_assignment public.driver_assignments;
  v_old_trip public.trips;
  v_new_trip public.trips;
  v_new_assignment public.driver_assignments;
  v_sibling_slot text;
  v_best_capacity integer := -1;
  v_rider_count integer;
  v_available integer;
  v_group_id uuid;
  v_old_time text;
  v_new_time text;
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
    raise exception 'You can only switch rides for your own children';
  end if;

  -- Load the current driver assignment
  select * into v_old_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_old_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  -- Load the current trip and verify it's afternoon
  select * into v_old_trip from public.trips where id = v_old_assignment.trip_id;
  if v_old_trip.id is null then
    raise exception 'Trip not found';
  end if;

  if v_old_trip.direction <> 'afternoon' then
    raise exception 'Can only switch between afternoon drive times';
  end if;

  v_group_id := v_old_assignment.group_id;

  -- Determine the sibling slot
  if v_old_trip.slot = 'pm_early' then
    v_sibling_slot := 'pm_late';
    v_old_time := to_char(v_old_trip.meeting_time, 'HH:MI AM');
  elsif v_old_trip.slot = 'pm_late' then
    v_sibling_slot := 'pm_early';
    v_old_time := to_char(v_old_trip.meeting_time, 'HH:MI AM');
  else
    raise exception 'Unknown afternoon slot: %', v_old_trip.slot;
  end if;

  -- Find the sibling afternoon trip for the same date
  select * into v_new_trip from public.trips
  where service_date = v_old_trip.service_date
    and direction = 'afternoon'
    and slot = v_sibling_slot
    and week_id = v_old_trip.week_id;

  if v_new_trip.id is null then
    raise exception 'No sibling afternoon trip found for this date';
  end if;

  v_new_time := to_char(v_new_trip.meeting_time, 'HH:MI AM');

  -- Find the driver_assignment with the most available capacity on the sibling trip
  for v_new_assignment in
    select * from public.driver_assignments
    where trip_id = v_new_trip.id
      and group_id = v_group_id
      and status in ('tentative', 'confirmed')
    order by child_passenger_capacity desc
  loop
    select count(*) into v_rider_count
    from public.rider_assignments
    where driver_assignment_id = v_new_assignment.id;

    v_available := v_new_assignment.child_passenger_capacity - v_rider_count;

    if v_available > v_best_capacity then
      v_best_capacity := v_available;
    end if;

    -- Pick the first assignment with available capacity
    if v_available > 0 then
      -- Found one with room — keep it
      exit;
    end if;
  end loop;

  if v_new_assignment.id is null then
    raise exception 'No driver assigned to the % PM trip', v_new_time;
  end if;

  if v_best_capacity <= 0 then
    raise exception 'The % PM cars are full', v_new_time;
  end if;

  -- Delete the old rider_assignment
  delete from public.rider_assignments
  where child_id = p_child_id
    and driver_assignment_id = p_driver_assignment_id;

  if not found then
    raise exception 'Child is not on this drive';
  end if;

  -- Insert the new rider_assignment on the destination trip
  insert into public.rider_assignments (
    group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
  )
  values (
    v_group_id, v_old_assignment.schedule_version_id,
    v_new_trip.id, v_new_assignment.id, p_child_id
  )
  on conflict (schedule_version_id, trip_id, child_id)
  do update set driver_assignment_id = v_new_assignment.id;

  -- Update ride_requests: old trip no longer needed, new trip now needed
  update public.ride_requests
  set needs_ride = false
  where child_id = p_child_id
    and trip_id = v_old_trip.id;

  update public.ride_requests
  set needs_ride = true
  where child_id = p_child_id
    and trip_id = v_new_trip.id;

  -- If no ride_request exists for the new trip, create one
  if not found then
    insert into public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, preference, created_by)
    select v_group_id, checkin_id, v_new_trip.id, p_child_id, true, 'specific', auth.uid()
    from public.ride_requests
    where child_id = p_child_id and trip_id = v_old_trip.id
    limit 1
    on conflict do nothing;
  end if;

  -- Audit event
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_group_id, auth.uid(), 'child_switched_afternoon_trip', 'rider_assignment',
    v_new_assignment.id::text,
    jsonb_build_object(
      'child_id', p_child_id,
      'child_name', v_child.first_name || ' ' || v_child.last_name,
      'old_driver_assignment_id', p_driver_assignment_id,
      'new_driver_assignment_id', v_new_assignment.id,
      'old_trip_id', v_old_trip.id,
      'new_trip_id', v_new_trip.id,
      'old_time', v_old_time,
      'new_time', v_new_time
    )
  );

  return jsonb_build_object(
    'success', true,
    'new_driver_assignment_id', v_new_assignment.id,
    'new_trip_id', v_new_trip.id,
    'old_driver_assignment_id', p_driver_assignment_id,
    'old_trip_id', v_old_trip.id,
    'child_id', p_child_id
  );
end;
$$;

revoke all on function public.switch_child_afternoon_trip(uuid, uuid) from public, authenticated;
grant execute on function public.switch_child_afternoon_trip(uuid, uuid) to authenticated;