-- Crewmate Phase 2 fix: swap_driver_assignments must update
-- child_passenger_capacity to the incoming driver's vehicle, and give a
-- legible error when that driver has no active household vehicle with
-- enough seats. Previously the swap kept the OLD car's capacity column
-- (stale seat math for placement and display) and a missing vehicle
-- produced an opaque NOT NULL violation instead of a clear error.

create or replace function public.swap_driver_assignments(
  p_assignment_a uuid,
  p_assignment_b uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_a record;
  v_b record;
  v_group uuid;
  v_seated_a integer;
  v_seated_b integer;
  v_vehicle_a uuid;
  v_vehicle_b uuid;
  v_capacity_a integer;
  v_capacity_b integer;
  v_driver_a_name text;
  v_driver_b_name text;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select * into v_a from public.driver_assignments where id = p_assignment_a;
  select * into v_b from public.driver_assignments where id = p_assignment_b;
  if v_a.id is null or v_b.id is null then
    raise exception 'Assignment not found';
  end if;
  if v_a.id = v_b.id then
    raise exception 'Cannot swap a drive with itself';
  end if;
  if v_a.group_id <> v_b.group_id then
    raise exception 'Drives are in different groups';
  end if;
  if v_a.trip_id = v_b.trip_id then
    raise exception 'Both drivers are on the same trip';
  end if;
  if v_a.driver_profile_id = v_b.driver_profile_id then
    raise exception 'Both drives belong to the same driver';
  end if;

  select v_a.group_id into v_group;

  if (select t.service_date from public.trips t where t.id = v_a.trip_id) < current_date
     or (select t.service_date from public.trips t where t.id = v_b.trip_id) < current_date then
    raise exception 'Cannot swap a past drive';
  end if;

  -- Neither driver may already hold another drive on the counterpart's trip.
  if exists (
    select 1 from public.driver_assignments da
    where da.trip_id = v_a.trip_id
      and da.driver_profile_id = v_b.driver_profile_id
      and da.status in ('tentative', 'confirmed')
      and da.id <> v_b.id
  ) or exists (
    select 1 from public.driver_assignments da
    where da.trip_id = v_b.trip_id
      and da.driver_profile_id = v_a.driver_profile_id
      and da.status in ('tentative', 'confirmed')
      and da.id <> v_a.id
  ) then
    raise exception 'A conflicting drive already exists for one of the trips';
  end if;

  -- Seated riders stay on each drive slot; the incoming car must have
  -- enough seats for them.
  select count(*) into v_seated_a
  from public.rider_assignments ra where ra.driver_assignment_id = p_assignment_a;
  select count(*) into v_seated_b
  from public.rider_assignments ra where ra.driver_assignment_id = p_assignment_b;

  select p.full_name into v_driver_a_name
  from public.profiles p where p.id = v_a.driver_profile_id;
  select p.full_name into v_driver_b_name
  from public.profiles p where p.id = v_b.driver_profile_id;

  -- Resolve each driver's vehicle with enough seats for the riders
  -- staying on their new drive.
  v_vehicle_a := public.resolve_driver_vehicle_for(v_b.driver_profile_id, v_seated_a);
  v_capacity_a := (
    select child_passenger_capacity from public.vehicles where id = v_vehicle_a
  );
  if v_vehicle_a is null or v_capacity_a is null then
    raise exception '% does not have an active car with enough seats for the % rider(s) staying on that drive',
      coalesce(v_driver_b_name, 'The other driver'), v_seated_a;
  end if;

  v_vehicle_b := public.resolve_driver_vehicle_for(v_a.driver_profile_id, v_seated_b);
  v_capacity_b := (
    select child_passenger_capacity from public.vehicles where id = v_vehicle_b
  );
  if v_vehicle_b is null or v_capacity_b is null then
    raise exception '% does not have an active car with enough seats for the % rider(s) staying on that drive',
      coalesce(v_driver_a_name, 'The other driver'), v_seated_b;
  end if;

  -- Swap drivers, each with their own car AND the correct seat count.
  update public.driver_assignments
  set driver_profile_id = v_b.driver_profile_id,
      vehicle_id = v_vehicle_a,
      child_passenger_capacity = v_capacity_a
  where id = p_assignment_a;

  update public.driver_assignments
  set driver_profile_id = v_a.driver_profile_id,
      vehicle_id = v_vehicle_b,
      child_passenger_capacity = v_capacity_b
  where id = p_assignment_b;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group, v_actor, 'swap_driver_assignments', 'driver_assignment', p_assignment_a::text,
          jsonb_build_object('assignment_a', p_assignment_a, 'assignment_b', p_assignment_b,
                             'driver_a', v_a.driver_profile_id, 'driver_b', v_b.driver_profile_id,
                             'vehicle_a', v_vehicle_a, 'vehicle_b', v_vehicle_b));

  return jsonb_build_object('swapped', true);
end;
$$;

revoke all on function public.swap_driver_assignments(uuid, uuid) from public, authenticated;
grant execute on function public.swap_driver_assignments(uuid, uuid) to authenticated;