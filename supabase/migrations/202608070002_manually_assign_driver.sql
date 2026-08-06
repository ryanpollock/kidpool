-- Coordinator manual-assign: directly assign a specific driver to an
-- uncovered trip, bypassing the greedy algorithm. This is the admin's
-- real superpower for when self-organization fails — they pick the person.
--
-- Unlike volunteer_for_uncovered_trip (which requires the caller's own
-- children to be uncovered), this is coordinator-only and can assign ANY
-- active member with an active vehicle, regardless of their previously
-- stated availability (per product decision: the admin is the human
-- override for availability boundaries).
--
-- Modeled on volunteer_for_uncovered_trip (202608052000): creates a
-- confirmed driver_assignment, moves/inserts rider_assignments for
-- truly-uncovered children up to capacity.

create or replace function public.manually_assign_driver(
  p_trip_id uuid,
  p_schedule_version_id uuid,
  p_driver_profile_id uuid,
  p_vehicle_id uuid
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
  v_is_coordinator boolean;
  v_vehicle public.vehicles;
  v_uncovered_child_ids uuid[];
  v_child_id uuid;
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

  v_group_id := v_trip.group_id;

  -- Verify caller is an active coordinator for this group
  select exists(
    select 1 from public.memberships
    where group_id = v_group_id
      and profile_id = auth.uid()
      and role = 'coordinator'
      and status = 'active'
  ) into v_is_coordinator;

  if not v_is_coordinator then
    raise exception 'Only coordinators can manually assign drivers';
  end if;

  -- Load and lock the schedule version
  select * into v_version from public.schedule_versions where id = p_schedule_version_id for update;
  if v_version.id is null then
    raise exception 'Schedule version not found';
  end if;

  if v_trip.group_id <> v_version.group_id then
    raise exception 'Trip and version do not belong to the same group';
  end if;

  -- Verify the target driver is an active member of the group
  -- (no availability check — admin overrides stated availability)
  perform 1 from public.memberships
  where group_id = v_group_id
    and profile_id = p_driver_profile_id
    and status = 'active';

  if not found then
    raise exception 'Target driver is not an active member of this group';
  end if;

  -- Verify the vehicle belongs to the driver's household and is active
  select * into v_vehicle from public.vehicles
  where id = p_vehicle_id
    and group_id = v_group_id
    and active = true
    and household_id in (
      select household_id from public.memberships
      where profile_id = p_driver_profile_id and status = 'active'
    );

  if v_vehicle.id is null then
    raise exception 'Vehicle not found or does not belong to the target driver';
  end if;

  -- Verify the driver isn't already tentative/confirmed for this trip
  perform 1 from public.driver_assignments
  where schedule_version_id = p_schedule_version_id
    and trip_id = p_trip_id
    and driver_profile_id = p_driver_profile_id
    and status in ('tentative', 'confirmed');

  if found then
    raise exception 'Driver is already assigned to this trip';
  end if;

  -- Find truly-uncovered children for this trip (same definition as
  -- volunteer_for_uncovered_trip: no rider_assignment on a tentative,
  -- confirmed, OR declined driver)
  select array_agg(rr.child_id order by c.last_name, c.first_name)
  into v_uncovered_child_ids
  from public.ride_requests rr
  join public.children c on c.id = rr.child_id
  where rr.trip_id = p_trip_id
    and rr.needs_ride = true
    and not exists (
      select 1 from public.rider_assignments ra
      join public.driver_assignments da on da.id = ra.driver_assignment_id
      where ra.schedule_version_id = p_schedule_version_id
        and ra.trip_id = p_trip_id
        and ra.child_id = rr.child_id
        and da.status in ('tentative', 'confirmed', 'declined')
    );

  -- Create the new confirmed assignment
  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  )
  values (
    v_group_id, p_schedule_version_id, p_trip_id,
    p_driver_profile_id, v_vehicle.id, v_vehicle.child_passenger_capacity,
    'confirmed'
  )
  returning * into new_assignment;

  -- Move/insert rider_assignments for uncovered children up to capacity
  if v_uncovered_child_ids is not null then
    foreach v_child_id in array v_uncovered_child_ids
    loop
      select count(*) into v_assigned_count
      from public.rider_assignments
      where driver_assignment_id = new_assignment.id;

      if v_assigned_count >= v_vehicle.child_passenger_capacity then
        exit;
      end if;

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
    v_group_id, auth.uid(), 'driver_manually_assigned', 'driver_assignment',
    new_assignment.id::text,
    jsonb_build_object(
      'trip_id', p_trip_id,
      'driver_profile_id', p_driver_profile_id,
      'vehicle', v_vehicle.label,
      'source', 'manual'
    )
  );

  return new_assignment;
end;
$$;

revoke all on function public.manually_assign_driver(uuid, uuid, uuid, uuid) from public;
grant execute on function public.manually_assign_driver(uuid, uuid, uuid, uuid) to authenticated;