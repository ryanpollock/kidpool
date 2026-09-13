-- Either-preference children can no longer be double-placed by the
-- volunteer / manual-assign flows.
--
-- What happened in production (Fri Sep 18, week of 2026-09-14): the 7 AM
-- scheduler correctly seated an "Either" child on pm_early. At 7:48 AM a
-- parent volunteered for the uncovered pm_late trip; both
-- volunteer_for_uncovered_trip and manually_assign_driver define "truly
-- uncovered" PER TRIP (needs_ride=true with no rider_assignment on THAT
-- trip), with no cross-trip dedup — so the either child, covered on 4:20,
-- looked uncovered on 5:15 and got placed on both cars.
--
-- The cross-trip dedup already exists in the full scheduler
-- (balanced-greedy-v2.ts:296-308), in surgical mode's output dedup
-- (generate-schedule), and in the client's uncovered alerts
-- (getUncoveredChildren). This migration adds it to the two RPCs that
-- place children onto new cars:
--
--   A child is NOT uncovered on an afternoon trip when their ride_request
--   preference on that trip is 'either' AND they already have a rider
--   row on the sibling standard afternoon trip (pm_early <-> pm_late,
--   same date, same schedule version, active driver assignment).

begin;

-- ── volunteer_for_uncovered_trip (redefined) ──

create or replace function public.volunteer_for_uncovered_trip(p_trip_id uuid, p_schedule_version_id uuid)
 RETURNS driver_assignments
 language plpgsql
 security definer
 SET search_path TO 'public'
AS $function$
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
  existing_assignment public.driver_assignments;
  v_existing_rider_count integer;
  v_available_capacity integer;
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
  -- Either-preference children already covered on the sibling afternoon trip
  -- (pm_early <-> pm_late, same date, same version) are NOT uncovered here —
  -- without this dedup they get placed on both cars (production incident,
  -- 2026-09-13).
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
    )
    and not (
      v_trip.slot in ('pm_early', 'pm_late')
      and rr.preference = 'either'
      and exists (
        select 1
        from public.rider_assignments sra
        join public.trips st on st.id = sra.trip_id
        join public.driver_assignments sda on sda.id = sra.driver_assignment_id
        where sra.schedule_version_id = p_schedule_version_id
          and sra.child_id = rr.child_id
          and st.service_date = v_trip.service_date
          and st.direction = 'afternoon'
          and st.slot in ('pm_early', 'pm_late')
          and st.slot <> v_trip.slot
          and sda.status in ('tentative', 'confirmed', 'declined')
      )
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
  order by coalesce(default_driver_id = auth.uid(), false) desc, child_passenger_capacity asc, label asc
  limit 1;

  if volunteer_vehicle.id is null then
    raise exception 'You need an active vehicle to volunteer';
  end if;

  -- Check if the caller is already an assigned driver for this trip
  select * into existing_assignment
  from public.driver_assignments
  where schedule_version_id = p_schedule_version_id
    and trip_id = p_trip_id
    and driver_profile_id = auth.uid()
    and status in ('tentative', 'confirmed')
  limit 1;

  if existing_assignment.id is not null then
    -- The caller is already driving this trip. Add their uncovered children
    -- to their existing car instead of creating a new assignment.
    select count(*) into v_existing_rider_count
    from public.rider_assignments
    where driver_assignment_id = existing_assignment.id;

    v_available_capacity := existing_assignment.child_passenger_capacity - v_existing_rider_count;

    if v_available_capacity < v_my_count then
      raise exception 'You are already driving this trip, but your car is full (% / % seats). Ask the coordinator to reassign children.',
        v_existing_rider_count, existing_assignment.child_passenger_capacity;
    end if;

    -- Use the existing assignment as the target
    new_assignment := existing_assignment;
  else
    -- Capacity check: vehicle must seat at least the volunteer's own children
    if volunteer_vehicle.child_passenger_capacity < v_my_count then
      raise exception 'Your vehicle seats % but % of your children need a ride',
        volunteer_vehicle.child_passenger_capacity, v_my_count;
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
  end if;

  -- Move existing rider_assignments for volunteer's own children from
  -- released/expired drivers to the assignment (avoids unique constraint violation)
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
  foreach v_child_id in array v_my_uncovered_child_ids loop
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
  -- ordered by last name for deterministic placement. Same either-sibling
  -- dedup applies: a child covered on the sibling afternoon trip is not
  -- uncovered on this one.
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
    )
    and not (
      v_trip.slot in ('pm_early', 'pm_late')
      and rr.preference = 'either'
      and exists (
        select 1
        from public.rider_assignments sra
        join public.trips st on st.id = sra.trip_id
        join public.driver_assignments sda on sda.id = sra.driver_assignment_id
        where sra.schedule_version_id = p_schedule_version_id
          and sra.child_id = rr.child_id
          and st.service_date = v_trip.service_date
          and st.direction = 'afternoon'
          and st.slot in ('pm_early', 'pm_late')
          and st.slot <> v_trip.slot
          and sda.status in ('tentative', 'confirmed', 'declined')
      )
    );

  if v_other_uncovered_child_ids is not null then
    foreach v_child_id in array v_other_uncovered_child_ids loop
      select count(*) into v_assigned_count
      from public.rider_assignments
      where driver_assignment_id = new_assignment.id;

      if v_assigned_count >= new_assignment.child_passenger_capacity then
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
    v_group_id, auth.uid(), 'drive_volunteered', 'driver_assignment',
    new_assignment.id::text,
    jsonb_build_object(
      'trip_id', p_trip_id,
      'vehicle', volunteer_vehicle.label,
      'source', 'uncovered',
      'reused_existing_assignment', existing_assignment.id is not null
    )
  );

  return new_assignment;
end;
$function$;

revoke all on function public.volunteer_for_uncovered_trip(uuid, uuid) from public;
grant execute on function public.volunteer_for_uncovered_trip(uuid, uuid) to authenticated;

-- ── manually_assign_driver (redefined) ──

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
  -- confirmed, OR declined driver). Either-preference children already
  -- covered on the sibling afternoon trip (pm_early <-> pm_late, same date,
  -- same version) are NOT uncovered — without this dedup a manual assign
  -- double-places them (production incident, 2026-09-13).
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
    )
    and not (
      v_trip.slot in ('pm_early', 'pm_late')
      and rr.preference = 'either'
      and exists (
        select 1
        from public.rider_assignments sra
        join public.trips st on st.id = sra.trip_id
        join public.driver_assignments sda on sda.id = sra.driver_assignment_id
        where sra.schedule_version_id = p_schedule_version_id
          and sra.child_id = rr.child_id
          and st.service_date = v_trip.service_date
          and st.direction = 'afternoon'
          and st.slot in ('pm_early', 'pm_late')
          and st.slot <> v_trip.slot
          and sda.status in ('tentative', 'confirmed', 'declined')
      )
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

commit;