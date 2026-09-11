-- Regression found by the full browser gate: the multi-vehicle RPC refresh
-- lost assignment reuse. Volunteering a second time collided with the unique
-- trip/version/driver key. Reuse only an inactive, empty assignment; preserve
-- the current vehicle selection, capacity checks, rider transfer and audit.
begin;
create or replace function public.volunteer_for_declined_drive(target_assignment_id uuid)
 RETURNS driver_assignments
 language plpgsql
 security definer
 SET search_path TO 'public'
AS $function$
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
  order by coalesce(default_driver_id = auth.uid(), false) desc, child_passenger_capacity asc, label asc
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
  on conflict (schedule_version_id, trip_id, driver_profile_id) do update
  set vehicle_id = excluded.vehicle_id,
      child_passenger_capacity = excluded.child_passenger_capacity,
      status = 'confirmed'
  where public.driver_assignments.status in ('declined', 'expired', 'released')
    and not exists (
      select 1 from public.rider_assignments previous_rider
      where previous_rider.driver_assignment_id = public.driver_assignments.id
    )
  returning * into new_assignment;

  if new_assignment.id is null then
    raise exception 'Your previous assignment still has riders or is already active. Please review that drive.';
  end if;

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
$function$;

revoke all on function public.volunteer_for_declined_drive(uuid) from public;
grant execute on function public.volunteer_for_declined_drive(uuid) to authenticated;


commit;
