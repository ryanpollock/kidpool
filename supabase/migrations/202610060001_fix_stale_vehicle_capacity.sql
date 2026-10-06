-- P0 FIX: place_child_in_vehicle and add_ride_request_for_child check
-- the driver_assignments.child_passenger_capacity (denormalized at schedule
-- generation time) instead of the vehicle's CURRENT capacity. When a parent
-- updates their vehicle capacity mid-week (e.g., Yana updated her Sienna from
-- 5 to 6 seats), the assignment keeps the stale value and the capacity check
-- rejects the placement ("That car is already full") even though the vehicle
-- now has space.
--
-- Fix: both functions now read the vehicle's current child_passenger_capacity
-- from the vehicles table (source of truth), matching the pattern already used
-- correctly in change_assignment_vehicle.

create or replace function public.place_child_in_vehicle(
  p_child_id uuid,
  p_trip_id uuid,
  p_driver_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_household_id uuid;
  v_group_id uuid;
  v_da record;
  v_trip record;
  v_seated integer;
  v_existing record;
  v_vehicle_capacity integer;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select c.household_id, c.group_id into v_household_id, v_group_id
  from public.children c where c.id = p_child_id;
  if v_household_id is null then
    raise exception 'Child not found';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.household_id = v_household_id
      and m.profile_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'Only a parent of this child can change their placement';
  end if;

  select * into v_da
  from public.driver_assignments da
  join public.trips t on t.id = da.trip_id
  where da.id = p_driver_assignment_id
    and da.trip_id = p_trip_id
    and da.status in ('tentative', 'confirmed')
    and t.status <> 'canceled';

  if v_da.id is null then
    raise exception 'That car is not driving this trip';
  end if;

  select t.* into v_trip from public.trips t where t.id = p_trip_id;
  if v_trip.service_date < current_date then
    raise exception 'Cannot change placement for a past trip';
  end if;

  -- FIX: read the vehicle's CURRENT capacity from the vehicles table,
  -- not the denormalized assignment value (which can go stale when the
  -- parent updates their vehicle mid-week).
  select v.child_passenger_capacity into v_vehicle_capacity
  from public.vehicles v
  where v.id = v_da.vehicle_id;

  if v_vehicle_capacity is null then
    raise exception 'Vehicle not found for this drive';
  end if;

  -- Capacity: named children already in this car.
  select count(*) into v_seated
  from public.rider_assignments ra
  where ra.driver_assignment_id = p_driver_assignment_id;

  if v_seated >= v_vehicle_capacity then
    raise exception 'That car is already full (% of % seats taken)', v_seated, v_vehicle_capacity;
  end if;

  -- Either-sibling dedup: never double-place an either-preference child
  -- on pm_early and pm_late of the same day.
  if v_trip.slot in ('pm_early', 'pm_late') then
    select ra.id, ra.trip_id into v_existing
    from public.rider_assignments ra
    join public.trips t on t.id = ra.trip_id
    join public.ride_requests rr on rr.trip_id = t.id and rr.child_id = p_child_id
    where ra.child_id = p_child_id
      and t.service_date = v_trip.service_date
      and t.slot in ('pm_early', 'pm_late')
      and t.slot <> v_trip.slot
      and t.status <> 'canceled'
    limit 1;
    if v_existing.id is not null then
      raise exception 'This child is already placed on the other afternoon trip that day';
    end if;
  end if;

  -- One active assignment per child per trip: move, don't duplicate.
  delete from public.rider_assignments
  where child_id = p_child_id and trip_id = p_trip_id
    and driver_assignment_id <> p_driver_assignment_id;

  insert into public.rider_assignments (group_id, schedule_version_id, trip_id, driver_assignment_id, child_id)
  values (v_group_id, v_da.schedule_version_id, p_trip_id, p_driver_assignment_id, p_child_id)
  on conflict (schedule_version_id, trip_id, child_id) do update
    set driver_assignment_id = excluded.driver_assignment_id;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group_id, v_actor, 'place_child_in_vehicle', 'child', p_child_id::text,
          jsonb_build_object('trip_id', p_trip_id, 'driver_assignment_id', p_driver_assignment_id, 'vehicle_capacity', v_vehicle_capacity));

  return jsonb_build_object('placed', true, 'trip_id', p_trip_id);
end;
$$;

revoke all on function public.place_child_in_vehicle(uuid, uuid, uuid) from public, authenticated;
grant execute on function public.place_child_in_vehicle(uuid, uuid, uuid) to authenticated;


create or replace function public.add_ride_request_for_child(
  p_child_id uuid,
  p_trip_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_household_id uuid;
  v_group_id uuid;
  v_week_id uuid;
  v_checkin_id uuid;
  v_target_da record;
  v_seated integer;
  v_vehicle_capacity integer;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select c.household_id, c.group_id into v_household_id, v_group_id
  from public.children c where c.id = p_child_id;
  if v_household_id is null then
    raise exception 'Child not found';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.household_id = v_household_id
      and m.profile_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'Only a parent of this child can request their rides';
  end if;

  select t.week_id into v_week_id from public.trips t where t.id = p_trip_id;
  if v_week_id is null then
    raise exception 'Trip not found';
  end if;
  if (select service_date from public.trips where id = p_trip_id) < current_date then
    raise exception 'Cannot add a ride for a past trip';
  end if;

  insert into public.weekly_checkins (group_id, week_id, household_id, status, submitted_by, submitted_at, max_drives)
  values (v_group_id, v_week_id, v_household_id, 'submitted', v_actor, now(), 0)
  on conflict (week_id, household_id) do nothing;

  select id into v_checkin_id
  from public.weekly_checkins
  where week_id = v_week_id and household_id = v_household_id;

  insert into public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by)
  values (v_group_id, v_checkin_id, p_trip_id, p_child_id, true, v_actor)
  on conflict (trip_id, child_id) do nothing;

  -- Attempt placement: a car with seats on this trip (smallest load first
  -- keeps big cars free). Unseated children remain counted as uncovered.
  -- FIX: read the vehicle's CURRENT capacity from the vehicles table.
  select da.*, v.child_passenger_capacity as vehicle_capacity,
         (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = da.id) as seated
  into v_target_da
  from public.driver_assignments da
  join public.trips t on t.id = da.trip_id
  join public.vehicles v on v.id = da.vehicle_id
  where da.trip_id = p_trip_id
    and da.status in ('tentative', 'confirmed')
    and t.status <> 'canceled'
  order by (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = da.id)
  limit 1;

  if v_target_da.id is not null and v_target_da.seated < v_target_da.vehicle_capacity then
    perform public.place_child_in_vehicle(p_child_id, p_trip_id, v_target_da.id);
  end if;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group_id, v_actor, 'add_ride_request', 'child', p_child_id::text,
          jsonb_build_object('trip_id', p_trip_id, 'placed', v_target_da.id is not null and v_target_da.seated < v_target_da.vehicle_capacity));

  return jsonb_build_object(
    'ride_requested', true,
    'placed', v_target_da.id is not null and v_target_da.seated < v_target_da.vehicle_capacity
  );
end;
$$;

revoke all on function public.add_ride_request_for_child(uuid, uuid) from public, authenticated;
grant execute on function public.add_ride_request_for_child(uuid, uuid) to authenticated;