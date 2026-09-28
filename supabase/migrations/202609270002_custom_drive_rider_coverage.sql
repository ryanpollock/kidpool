-- Custom-drive seats count as coverage everywhere a child can be placed
-- onto a standard-trip car (decision 2026-09-27).
--
-- Production incident (Sun 2026-09-27, week of 2026-09-28): a parent
-- joined Leah K to a parent-offered 4:20 PM custom drive for Wednesday.
-- The family's check-in still requested the standard 5:15 PM ride
-- (ride_requests.needs_ride=true), and NOTHING treated the custom seat
-- as coverage: the Home/This Week "needs a ride" alerts persisted, a
-- regeneration would seat her on the standard car too (double-booked),
-- and volunteer_for_uncovered_trip / manually_assign_driver would sweep
-- her onto the standard trip — the same class of double-placement as the
-- 2026-09-13 either-sibling incident.
--
-- Rule (extends the 202609130002 cross-trip dedup family):
--   A child with a rider_assignment on a CUSTOM trip (same date, same
--   direction, active driver, same schedule version) is COVERED for the
--   standard trips (am / pm_early / pm_late) of that date+direction —
--   for both 'specific' and 'either' preferences. Joining a custom drive
--   is a household action that supersedes the stale check-in row.
--   Coverage is computed, never mutating ride_requests: leave/cancel of
--   the custom drive automatically restores the standard-trip need.
--
-- New/changed guards in this migration:
--   1. join_custom_drive / offer_custom_drive reject a child already on
--      ANOTHER custom drive for the same date+direction (a child rides
--      once per direction per day). Seats on STANDARD trips are still
--      allowed to coexist — the client's post-join overlap prompt
--      ("Cancel the other ride" / "Keep both") owns that flow.
--   2. volunteer_for_uncovered_trip + manually_assign_driver treat
--      custom-seat coverage exactly like the either-sibling coverage:
--      the child is not "truly uncovered" on the standard trip.
--   3. volunteer_for_uncovered_trip rejects a volunteer who has a custom
--      assignment at the identical date+time (same physical drive).
--      manually_assign_driver keeps its deliberate admin-override
--      freedom for drivers, but the child sweep does respect coverage.

begin;

-- ── offer_custom_drive: reject double-extra-drive children ──

create or replace function public.offer_custom_drive(
  p_group_id uuid,
  p_service_date date,
  p_direction public.trip_direction,
  p_meeting_time time,
  p_child_ids uuid[] default '{}'
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_membership public.memberships;
  v_group public.groups;
  v_week public.weeks;
  v_version_id uuid;
  v_vehicle public.vehicles;
  v_trip public.trips;
  v_assignment public.driver_assignments;
  v_child_id uuid;
  v_child_count integer;
  v_conflict_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_membership
  from public.memberships
  where profile_id = auth.uid()
    and group_id = p_group_id
    and status = 'active'
  limit 1;

  if v_membership.id is null then
    raise exception 'You are not an active member of this group';
  end if;

  select * into v_group from public.groups where id = p_group_id;

  select * into v_week
  from public.weeks
  where group_id = p_group_id
    and p_service_date between starts_on and starts_on + 6
  limit 1;

  if v_week.id is null then
    raise exception 'That date is not part of a scheduled week';
  end if;

  select id into v_version_id
  from public.schedule_versions
  where week_id = v_week.id
    and group_id = p_group_id
    and status = 'published'
  order by published_at desc
  limit 1;

  if v_version_id is null then
    raise exception 'The schedule for that week is not published yet';
  end if;

  if (p_service_date::timestamp + p_meeting_time) at time zone v_group.timezone <= now() then
    raise exception 'That pickup time has already passed';
  end if;

  select count(*) into v_conflict_count
  from public.driver_assignments da
  join public.trips t on t.id = da.trip_id
  where da.driver_profile_id = auth.uid()
    and da.status in ('tentative', 'confirmed')
    and t.service_date = p_service_date
    and t.meeting_time = p_meeting_time;

  if v_conflict_count > 0 then
    raise exception 'You are already driving at that time';
  end if;

  select * into v_vehicle
  from public.vehicles
  where group_id = p_group_id
    and household_id = v_membership.household_id
    and active = true
  order by coalesce(default_driver_id = auth.uid(), false) desc,
           child_passenger_capacity asc, label asc
  limit 1;

  if v_vehicle.id is null then
    raise exception 'You need an active vehicle to offer a drive';
  end if;

  v_child_count := coalesce(array_length(p_child_ids, 1), 0);
  if v_child_count > v_vehicle.child_passenger_capacity then
    raise exception 'Your vehicle seats % children', v_vehicle.child_passenger_capacity;
  end if;

  foreach v_child_id in array p_child_ids loop
    if not exists (
      select 1 from public.children
      where id = v_child_id
        and household_id = v_membership.household_id
        and active = true
    ) then
      raise exception 'You can only add your own children to your drive';
    end if;
    if exists (
      select 1
      from public.rider_assignments och
      join public.trips ot on ot.id = och.trip_id
      join public.driver_assignments oda on oda.id = och.driver_assignment_id
      where och.schedule_version_id = v_version_id
        and och.child_id = v_child_id
        and ot.slot = 'custom'
        and ot.service_date = p_service_date
        and ot.direction = p_direction
        and oda.status in ('tentative', 'confirmed')
    ) then
      raise exception 'That child is already on another extra drive that day';
    end if;
  end loop;

  insert into public.trips (
    group_id, week_id, service_date, direction, slot,
    meeting_time, departure_time, origin, destination
  )
  values (
    p_group_id, v_week.id, p_service_date, p_direction, 'custom',
    p_meeting_time, p_meeting_time + interval '5 minutes',
    case when p_direction = 'morning' then v_group.meeting_point else v_group.school_name end,
    case when p_direction = 'morning' then v_group.school_name else v_group.meeting_point end
  )
  returning * into v_trip;

  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  )
  values (
    p_group_id, v_version_id, v_trip.id, auth.uid(),
    v_vehicle.id, v_vehicle.child_passenger_capacity, 'confirmed'
  )
  returning * into v_assignment;

  foreach v_child_id in array p_child_ids loop
    insert into public.rider_assignments (
      group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
    )
    values (
      p_group_id, v_version_id, v_trip.id, v_assignment.id, v_child_id
    )
    on conflict (schedule_version_id, trip_id, child_id) do nothing;
  end loop;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    p_group_id, auth.uid(), 'custom_drive_offered', 'trip', v_trip.id::text,
    jsonb_build_object(
      'trip_id', v_trip.id,
      'assignment_id', v_assignment.id,
      'direction', p_direction,
      'meeting_time', p_meeting_time,
      'vehicle', v_vehicle.label,
      'own_children', v_child_count
    )
  );

  return v_assignment;
end;
$$;

revoke all on function public.offer_custom_drive(uuid, date, public.trip_direction, time, uuid[]) from public;
grant execute on function public.offer_custom_drive(uuid, date, public.trip_direction, time, uuid[]) to authenticated;

-- ── join_custom_drive (redefined): reject double-extra-drive children ──

create or replace function public.join_custom_drive(
  p_trip_id uuid,
  p_child_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip public.trips;
  v_group public.groups;
  v_version_id uuid;
  v_assignment public.driver_assignments;
  v_child_id uuid;
  v_current_riders integer;
  v_to_add integer := 0;
  v_seats_left integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_trip from public.trips where id = p_trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  if v_trip.slot <> 'custom' then
    raise exception 'Only custom drives can be joined directly';
  end if;

  if not exists (
    select 1 from public.memberships
    where profile_id = auth.uid()
      and group_id = v_trip.group_id
      and status = 'active'
  ) then
    raise exception 'You are not an active member of this group';
  end if;

  select * into v_group from public.groups where id = v_trip.group_id;

  if (v_trip.service_date::timestamp + v_trip.meeting_time) at time zone v_group.timezone <= now() then
    raise exception 'That pickup time has already passed';
  end if;

  v_version_id := public.resolve_custom_drive_version(v_trip.week_id, v_trip.group_id);

  if v_version_id is null then
    raise exception 'No schedule version exists for this week yet';
  end if;

  select * into v_assignment
  from public.driver_assignments
  where schedule_version_id = v_version_id
    and trip_id = p_trip_id
    and status in ('tentative', 'confirmed')
  limit 1;

  if v_assignment.id is null then
    raise exception 'This drive no longer has a driver';
  end if;

  select count(*) into v_current_riders
  from public.rider_assignments
  where driver_assignment_id = v_assignment.id;

  foreach v_child_id in array p_child_ids loop
    if not exists (
      select 1 from public.children
      where id = v_child_id and active = true
    ) then
      raise exception 'Child not found';
    end if;
    if not exists (
      select 1 from public.memberships m
      join public.children c on c.household_id = m.household_id
      where m.profile_id = auth.uid()
        and m.group_id = v_trip.group_id
        and m.status = 'active'
        and c.id = v_child_id
    ) then
      raise exception 'You can only add your own children';
    end if;
    -- A child rides once per direction per day: reject a seat on a second
    -- extra drive for the same date+direction. Seats on STANDARD trips
    -- are deliberately allowed here — the client's post-join overlap
    -- prompt ("Cancel the other ride" / "Keep both") owns that flow.
    if exists (
      select 1
      from public.rider_assignments och
      join public.trips ot on ot.id = och.trip_id
      join public.driver_assignments oda on oda.id = och.driver_assignment_id
      where och.schedule_version_id = v_version_id
        and och.child_id = v_child_id
        and och.trip_id <> p_trip_id
        and ot.slot = 'custom'
        and ot.service_date = v_trip.service_date
        and ot.direction = v_trip.direction
        and oda.status in ('tentative', 'confirmed')
    ) then
      raise exception 'That child is already on another extra drive that day';
    end if;
    if not exists (
      select 1 from public.rider_assignments
      where schedule_version_id = v_version_id
        and trip_id = p_trip_id
        and child_id = v_child_id
    ) then
      v_to_add := v_to_add + 1;
    end if;
  end loop;

  v_seats_left := v_assignment.child_passenger_capacity - v_current_riders;
  if v_to_add > v_seats_left then
    raise exception 'Only % seat% left on this drive',
      v_seats_left, case when v_seats_left = 1 then '' else 's' end;
  end if;

  foreach v_child_id in array p_child_ids loop
    insert into public.rider_assignments (
      group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
    )
    values (
      v_trip.group_id, v_version_id, p_trip_id, v_assignment.id, v_child_id
    )
    on conflict (schedule_version_id, trip_id, child_id) do nothing;
  end loop;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_trip.group_id, auth.uid(), 'custom_drive_joined', 'trip', p_trip_id::text,
    jsonb_build_object('children_added', v_to_add)
  );
end;
$$;

revoke all on function public.join_custom_drive(uuid, uuid[]) from public;
grant execute on function public.join_custom_drive(uuid, uuid[]) to authenticated;

-- ── volunteer_for_uncovered_trip (redefined): custom-seat coverage ──

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

  select * into v_trip from public.trips where id = p_trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  select * into v_version from public.schedule_versions where id = p_schedule_version_id for update;
  if v_version.id is null then
    raise exception 'Schedule version not found';
  end if;

  if v_trip.group_id <> v_version.group_id then
    raise exception 'Trip and version do not belong to the same group';
  end if;

  v_group_id := v_version.group_id;

  -- A custom drive at the identical date+time is the same physical drive:
  -- a volunteer cannot double-book themselves across a custom offer
  -- (e.g., Tue/Thu 4:20 PM custom vs the 4:20 PM pm_early standard slot).
  if exists (
    select 1
    from public.driver_assignments da
    join public.trips t on t.id = da.trip_id
    where da.schedule_version_id = p_schedule_version_id
      and da.driver_profile_id = auth.uid()
      and da.status in ('tentative', 'confirmed')
      and t.slot = 'custom'
      and t.service_date = v_trip.service_date
      and t.meeting_time = v_trip.meeting_time
  ) then
    raise exception 'You are already driving at that time';
  end if;

  -- A child is "truly uncovered" if they have a ride_request with needs_ride=true
  -- AND no rider_assignment on a tentative, confirmed, OR declined driver.
  -- Either-preference children already covered on the sibling afternoon trip
  -- (pm_early <-> pm_late, same date, same version) are NOT uncovered here —
  -- without this dedup they get placed on both cars (production incident,
  -- 2026-09-13). Children covered by a CUSTOM drive for the same
  -- date+direction are also NOT uncovered — joining an extra drive is the
  -- household's current choice, for either AND specific preferences
  -- (production incident, 2026-09-27).
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
    )
    and not exists (
      select 1
      from public.rider_assignments cra
      join public.trips ct on ct.id = cra.trip_id
      join public.driver_assignments cda on cda.id = cra.driver_assignment_id
      where cra.schedule_version_id = p_schedule_version_id
        and cra.child_id = rr.child_id
        and ct.slot = 'custom'
        and ct.service_date = v_trip.service_date
        and ct.direction = v_trip.direction
        and cda.status in ('tentative', 'confirmed')
    );

  if v_my_uncovered_child_ids is null then
    raise exception 'Your child is not uncovered for this trip';
  end if;

  v_my_count := array_length(v_my_uncovered_child_ids, 1);

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

  select * into existing_assignment
  from public.driver_assignments
  where schedule_version_id = p_schedule_version_id
    and trip_id = p_trip_id
    and driver_profile_id = auth.uid()
    and status in ('tentative', 'confirmed')
  limit 1;

  if existing_assignment.id is not null then
    select count(*) into v_existing_rider_count
    from public.rider_assignments
    where driver_assignment_id = existing_assignment.id;

    v_available_capacity := existing_assignment.child_passenger_capacity - v_existing_rider_count;

    if v_available_capacity < v_my_count then
      raise exception 'You are already driving this trip, but your car is full (% / % seats). Ask the coordinator to reassign children.',
        v_existing_rider_count, existing_assignment.child_passenger_capacity;
    end if;

    new_assignment := existing_assignment;
  else
    if volunteer_vehicle.child_passenger_capacity < v_my_count then
      raise exception 'Your vehicle seats % but % of your children need a ride',
        volunteer_vehicle.child_passenger_capacity, v_my_count;
    end if;

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
  -- and custom-seat dedup applies: a child covered on the sibling
  -- afternoon trip OR on a custom drive for this date+direction is not
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
    )
    and not exists (
      select 1
      from public.rider_assignments cra
      join public.trips ct on ct.id = cra.trip_id
      join public.driver_assignments cda on cda.id = cra.driver_assignment_id
      where cra.schedule_version_id = p_schedule_version_id
        and cra.child_id = rr.child_id
        and ct.slot = 'custom'
        and ct.service_date = v_trip.service_date
        and ct.direction = v_trip.direction
        and cda.status in ('tentative', 'confirmed')
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

-- ── manually_assign_driver (redefined): custom-seat coverage ──

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

  select * into v_trip from public.trips where id = p_trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  v_group_id := v_trip.group_id;

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

  select * into v_version from public.schedule_versions where id = p_schedule_version_id for update;
  if v_version.id is null then
    raise exception 'Schedule version not found';
  end if;

  if v_trip.group_id <> v_version.group_id then
    raise exception 'Trip and version do not belong to the same group';
  end if;

  perform 1 from public.memberships
  where group_id = v_group_id
    and profile_id = p_driver_profile_id
    and status = 'active';

  if not found then
    raise exception 'Target driver is not an active member of this group';
  end if;

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
  -- covered on the sibling afternoon trip (pm_early <-> pm_late, same
  -- date, same version) and children covered by a CUSTOM drive for the
  -- same date+direction are NOT uncovered — without this dedup a manual
  -- assign double-places them (production incidents 2026-09-13,
  -- 2026-09-27).
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
    )
    and not exists (
      select 1
      from public.rider_assignments cra
      join public.trips ct on ct.id = cra.trip_id
      join public.driver_assignments cda on cda.id = cra.driver_assignment_id
      where cra.schedule_version_id = p_schedule_version_id
        and cra.child_id = rr.child_id
        and ct.slot = 'custom'
        and ct.service_date = v_trip.service_date
        and ct.direction = v_trip.direction
        and cda.status in ('tentative', 'confirmed')
    );

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