-- Fix volunteer_for_uncovered_trip:
-- 1. A child is "truly uncovered" only if they have NO rider_assignment on
--    a tentative, confirmed, OR declined driver. Children on declined
--    drivers are handled by the declined-drive alert + volunteer_for_declined_drive.
-- 2. Use UPDATE (move) for existing rider_assignments on released/expired
--    drivers, then INSERT for children with no rider_assignment at all.
--    This avoids the unique constraint violation on (schedule_version_id, trip_id, child_id).

create or replace function public.volunteer_for_uncovered_trip(
  p_trip_id uuid,
  p_schedule_version_id uuid
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip public.trips;
  v_version public.schedule_versions;
  v_group_id uuid;
  volunteer_vehicle public.vehicles;
  v_my_uncovered_child_ids uuid[];
  v_other_uncovered_child_ids uuid[];
  v_child_id uuid;
  v_my_count integer;
  v_assigned_count integer;
  new_assignment public.driver_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load and lock the trip
  select * into v_trip from public.trips where id = p_trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  -- Load and lock the schedule version
  select * into v_version from public.schedule_versions where id = p_schedule_version_id for update;
  if v_version.id is null then
    raise exception 'Schedule version not found';
  end if;

  if v_trip.group_id <> v_version.group_id then
    raise exception 'Trip and version do not belong to the same group';
  end if;

  v_group_id := v_version.group_id;

  -- A child is "truly uncovered" if they have a ride_request with needs_ride=true
  -- AND no rider_assignment on a tentative, confirmed, OR declined driver.
  -- Children on declined drivers are handled by the declined-drive alert flow.
  -- Children on tentative/confirmed drivers have a driver (pending or confirmed).
  -- Only children with no rider_assignment, or rider_assignments only on
  -- released/expired drivers, are truly uncovered.

  -- Find the caller's own truly-uncovered children for this trip
  select array_agg(rr.child_id)
  into v_my_uncovered_child_ids
  from public.ride_requests rr
  where rr.trip_id = p_trip_id
    and rr.needs_ride = true
    and rr.child_id in (
      select c.id from public.children c
      join public.memberships m on m.household_id = c.household_id
      where m.profile_id = auth.uid() and m.status = 'active'
    )
    and not exists (
      select 1 from public.rider_assignments ra
      join public.driver_assignments da on da.id = ra.driver_assignment_id
      where ra.schedule_version_id = p_schedule_version_id
        and ra.trip_id = p_trip_id
        and ra.child_id = rr.child_id
        and da.status in ('tentative', 'confirmed', 'declined')
    );

  if v_my_uncovered_child_ids is null then
    raise exception 'Your child is not uncovered for this trip';
  end if;

  v_my_count := array_length(v_my_uncovered_child_ids, 1);

  -- Select the volunteer's biggest active vehicle in the group
  select * into volunteer_vehicle
  from public.vehicles
  where group_id = v_group_id
    and household_id in (
      select household_id from public.memberships
      where profile_id = auth.uid() and status = 'active'
    )
    and active = true
  order by child_passenger_capacity desc, created_at asc
  limit 1;

  if volunteer_vehicle.id is null then
    raise exception 'You need an active vehicle to volunteer';
  end if;

  -- Capacity check: vehicle must seat at least the volunteer's own children
  if volunteer_vehicle.child_passenger_capacity < v_my_count then
    raise exception 'Your vehicle seats % but % of your children need a ride',
      volunteer_vehicle.child_passenger_capacity, v_my_count;
  end if;

  -- Verify the caller isn't already assigned to drive this trip
  perform 1
  from public.driver_assignments
  where schedule_version_id = p_schedule_version_id
    and trip_id = p_trip_id
    and driver_profile_id = auth.uid()
    and status in ('tentative', 'confirmed');

  if found then
    raise exception 'You are already assigned to drive this trip';
  end if;

  -- Create the new confirmed assignment
  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  )
  values (
    v_group_id, p_schedule_version_id, p_trip_id,
    auth.uid(), volunteer_vehicle.id, volunteer_vehicle.child_passenger_capacity,
    'confirmed'
  )
  returning * into new_assignment;

  -- Move existing rider_assignments for volunteer's own children from
  -- released/expired drivers to the new assignment (avoids unique constraint violation)
  update public.rider_assignments
  set driver_assignment_id = new_assignment.id
  where schedule_version_id = p_schedule_version_id
    and trip_id = p_trip_id
    and child_id = any(v_my_uncovered_child_ids)
    and driver_assignment_id in (
      select id from public.driver_assignments
      where schedule_version_id = p_schedule_version_id
        and status not in ('tentative', 'confirmed', 'declined')
    );

  -- Insert new rider_assignments for volunteer's own children who don't have one yet
  -- (ON CONFLICT handles the case where the UPDATE above didn't find a row to move)
  foreach v_child_id in array v_my_uncovered_child_ids
  loop
    insert into public.rider_assignments (
      group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
    )
    values (
      v_group_id, p_schedule_version_id, p_trip_id, new_assignment.id, v_child_id
    )
    on conflict (schedule_version_id, trip_id, child_id)
    do update set driver_assignment_id = excluded.driver_assignment_id;
  end loop;

  -- Then assign other truly-uncovered children up to remaining capacity,
  -- ordered by last name for deterministic placement
  select array_agg(rr.child_id order by c.last_name, c.first_name)
  into v_other_uncovered_child_ids
  from public.ride_requests rr
  join public.children c on c.id = rr.child_id
  where rr.trip_id = p_trip_id
    and rr.needs_ride = true
    and rr.child_id <> all(v_my_uncovered_child_ids)
    and not exists (
      select 1 from public.rider_assignments ra
      join public.driver_assignments da on da.id = ra.driver_assignment_id
      where ra.schedule_version_id = p_schedule_version_id
        and ra.trip_id = p_trip_id
        and ra.child_id = rr.child_id
        and da.status in ('tentative', 'confirmed', 'declined')
    );

  if v_other_uncovered_child_ids is not null then
    foreach v_child_id in array v_other_uncovered_child_ids
    loop
      select count(*) into v_assigned_count
      from public.rider_assignments
      where driver_assignment_id = new_assignment.id;

      if v_assigned_count >= volunteer_vehicle.child_passenger_capacity then
        exit;
      end if;

      -- Move existing rider_assignment from released/expired driver, or insert new
      insert into public.rider_assignments (
        group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
      )
      values (
        v_group_id, p_schedule_version_id, p_trip_id, new_assignment.id, v_child_id
      )
      on conflict (schedule_version_id, trip_id, child_id)
      do update set driver_assignment_id = excluded.driver_assignment_id;
    end loop;
  end if;

  -- Audit
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_group_id, auth.uid(), 'drive_volunteered', 'driver_assignment',
    new_assignment.id::text,
    jsonb_build_object(
      'trip_id', p_trip_id,
      'vehicle', volunteer_vehicle.label,
      'source', 'uncovered'
    )
  );

  return new_assignment;
end;
$$;

revoke all on function public.volunteer_for_uncovered_trip(uuid, uuid) from public;
grant execute on function public.volunteer_for_uncovered_trip(uuid, uuid) to authenticated;