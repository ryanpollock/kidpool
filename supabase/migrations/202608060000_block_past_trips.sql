-- Block cancel, volunteer, and re-accept for trips that already happened.
-- A parent should not be able to:
--   - cancel a drive for a trip that already departed (retroactively stranding kids)
--   - volunteer to drive a trip that already departed
--   - re-accept a drive for a trip that already departed
-- The guard compares trip.service_date < now()::date, so same-day trips
-- are still actionable even after departure time (a parent may need to
-- cancel Tuesday's morning drive at 8:30 AM if something came up).

-- ── respond_to_driver_assignment: add past-trip guard ──
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
  v_trip public.trips;
  v_rider_count integer;
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

  -- Guard: only allow re-response when the assignment is still actionable.
  if assignment.status not in ('tentative', 'confirmed', 'declined', 'expired') then
    raise exception 'This assignment can no longer be responded to (status: %)', assignment.status;
  end if;

  -- Guard for expired: a rider family may have already taken over via
  -- volunteer_for_uncovered_trip. If the rider rows have been moved
  -- away, re-accept would resurrect a zero-rider confirmed assignment.
  if assignment.status = 'expired' then
    select count(*) into v_rider_count
    from public.rider_assignments
    where driver_assignment_id = assignment.id;

    if v_rider_count = 0 then
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

-- ── volunteer_for_declined_drive: add past-trip guard ──
create or replace function public.volunteer_for_declined_drive(
  target_assignment_id uuid
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment public.driver_assignments;
  new_assignment public.driver_assignments;
  volunteer_vehicle public.vehicles;
  rider_count integer;
  v_trip public.trips;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load the declined assignment
  select * into assignment
  from public.driver_assignments
  where id = target_assignment_id
  for update;

  if assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  if assignment.status <> 'declined' then
    raise exception 'This assignment is not declined';
  end if;

  -- Guard: block volunteering for past trips
  select * into v_trip from public.trips where id = assignment.trip_id;
  if v_trip.id is not null and v_trip.service_date < now()::date then
    raise exception 'This trip has already happened';
  end if;

  -- Block the original declined driver from volunteering via this path.
  if assignment.driver_profile_id = auth.uid() then
    raise exception 'You declined this drive. Use Review individually to re-accept it instead.';
  end if;

  -- Verify the caller is an affected parent: their child must be a
  -- rider on this assignment
  select count(*) into rider_count
  from public.rider_assignments ra
  join public.children c on c.id = ra.child_id
  join public.memberships m on m.household_id = c.household_id
  where ra.driver_assignment_id = assignment.id
    and m.profile_id = auth.uid()
    and m.status = 'active';

  if rider_count = 0 then
    raise exception 'Only affected parents can volunteer for this drive';
  end if;

  -- Select the volunteer's biggest active vehicle in the group
  select * into volunteer_vehicle
  from public.vehicles
  where group_id = assignment.group_id
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

  -- Capacity check: reject if the volunteer's vehicle is too small
  if volunteer_vehicle.child_passenger_capacity < rider_count then
    raise exception 'Your vehicle seats % but % child% need a ride. Try asking the admin to regenerate the schedule.',
      volunteer_vehicle.child_passenger_capacity, rider_count,
      case when rider_count = 1 then '' else 'ren' end;
  end if;

  -- Verify the caller isn't already assigned to drive this trip
  perform 1
  from public.driver_assignments
  where schedule_version_id = assignment.schedule_version_id
    and trip_id = assignment.trip_id
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
    assignment.group_id, assignment.schedule_version_id, assignment.trip_id,
    auth.uid(), volunteer_vehicle.id, volunteer_vehicle.child_passenger_capacity,
    'confirmed'
  )
  returning * into new_assignment;

  -- Move rider_assignments from the declined assignment to the new one
  update public.rider_assignments
  set driver_assignment_id = new_assignment.id
  where driver_assignment_id = assignment.id;

  -- Mark the old assignment as released
  update public.driver_assignments
  set status = 'released'
  where id = assignment.id;

  -- Audit
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    assignment.group_id, auth.uid(), 'drive_volunteered', 'driver_assignment',
    new_assignment.id::text,
    jsonb_build_object(
      'replaced_assignment_id', assignment.id,
      'trip_id', assignment.trip_id,
      'vehicle', volunteer_vehicle.label
    )
  );

  return new_assignment;
end;
$$;

revoke all on function public.volunteer_for_declined_drive(uuid) from public;
grant execute on function public.volunteer_for_declined_drive(uuid) to authenticated;

-- ── volunteer_for_uncovered_trip: add past-trip guard ──
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

  -- Guard: block volunteering for past trips
  if v_trip.service_date < now()::date then
    raise exception 'This trip has already happened';
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
        and da.status in ('tentative', 'confirmed')
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

  -- Capacity check
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

  -- Assign the volunteer's own children first
  foreach v_child_id in array v_my_uncovered_child_ids
  loop
    insert into public.rider_assignments (
      group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
    )
    values (
      v_group_id, p_schedule_version_id, p_trip_id, new_assignment.id, v_child_id
    );
  end loop;

  -- Then assign other truly-uncovered children up to remaining capacity
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
        and da.status in ('tentative', 'confirmed')
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

      insert into public.rider_assignments (
        group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
      )
      values (
        v_group_id, p_schedule_version_id, p_trip_id, new_assignment.id, v_child_id
      );
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