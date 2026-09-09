-- Ad hoc custom drives: a parent offers a one-off drive at an arbitrary
-- time (e.g. 4:50 PM pickup one day) and can take other kids along.
--
-- Custom drives live in the existing trips table with slot='custom' and
-- an arbitrary meeting_time. They are created mid-week, after the weekly
-- schedule is published, so their driver_assignment (+ rider rows) attach
-- to the current published schedule_version and appear in every live
-- roster read (getLatestPublishedVersion joins assignments per version).
--
-- Schema changes:
--   1. Widen trips_slot_check to admit 'custom'.
--   2. Replace unique(week_id, service_date, slot) with a partial unique
--      index covering standard slots only, so multiple custom drives can
--      exist on the same day while am/pm_early/pm_late stay unique.
--
-- Four security-definer RPCs follow the volunteer-RPC invariants
-- (202609060002): auth guard, membership guard, future-trip guard,
-- vehicle auto-selection mirroring the client resolveDriverVehicle rule,
-- rider capacity (also enforced by the enforce_rider_assignment_capacity
-- trigger), audit events, revoke from public + grant to authenticated.

begin;

-- 1. Widen the slot CHECK
alter table public.trips drop constraint trips_slot_check;
alter table public.trips
  add constraint trips_slot_check check (slot in ('am', 'pm_early', 'pm_late', 'custom'));

-- 2. Standard slots stay unique per (week, date); custom rows may repeat
alter table public.trips drop constraint trips_week_id_service_date_slot_key;
create unique index trips_week_date_standard_slot_key
  on public.trips (week_id, service_date, slot)
  where slot <> 'custom';

-- ── offer_custom_drive ──
-- Creates the trip + a confirmed driver_assignment for the caller on the
-- current published schedule_version, with the caller's own children as
-- initial riders. Any active member with a household vehicle may offer.

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
  v_version public.schedule_versions;
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

  -- Caller must be an active member of the group
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

  -- The date must fall inside an existing week of this group
  select * into v_week
  from public.weeks
  where group_id = p_group_id
    and p_service_date between starts_on and starts_on + 6
  limit 1;

  if v_week.id is null then
    raise exception 'That date is not part of a scheduled week';
  end if;

  -- The week's schedule must be published — custom drives attach to the
  -- published version so they render in every live roster read.
  select * into v_version
  from public.schedule_versions
  where week_id = v_week.id
    and group_id = p_group_id
    and status = 'published'
  order by published_at desc
  limit 1;

  if v_version.id is null then
    raise exception 'The schedule for that week is not published yet';
  end if;

  -- Future-trip guard (pilot timezone): block offering a drive whose
  -- pickup time has already passed.
  if (p_service_date::timestamp + p_meeting_time) at time zone v_group.timezone <= now() then
    raise exception 'That pickup time has already passed';
  end if;

  -- One drive per driver per exact date+time (a custom drive at a
  -- standard slot's time would double-book the same physical drive).
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

  -- Vehicle auto-selection (mirrors client resolveDriverVehicle):
  -- caller's tagged car, else smallest-capacity active household vehicle.
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

  -- Own children riding along (may be empty — a pure capacity offer)
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
  end loop;

  -- Create the trip
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

  -- Confirmed driver assignment on the published version
  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  )
  values (
    p_group_id, v_version.id, v_trip.id, auth.uid(),
    v_vehicle.id, v_vehicle.child_passenger_capacity, 'confirmed'
  )
  returning * into v_assignment;

  -- Own children as initial riders
  foreach v_child_id in array p_child_ids loop
    insert into public.rider_assignments (
      group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
    )
    values (
      p_group_id, v_version.id, v_trip.id, v_assignment.id, v_child_id
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

-- ── join_custom_drive ──
-- First-come-first-served: an active member adds their own children to a
-- custom drive's confirmed driver assignment, up to remaining capacity.

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
  v_version public.schedule_versions;
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

  select * into v_version
  from public.schedule_versions
  where week_id = v_trip.week_id
    and group_id = v_trip.group_id
    and status = 'published'
  order by published_at desc
  limit 1;

  if v_version.id is null then
    raise exception 'The schedule for this week is not published';
  end if;

  -- The drive's confirmed assignment on the published version
  select * into v_assignment
  from public.driver_assignments
  where schedule_version_id = v_version.id
    and trip_id = p_trip_id
    and status in ('tentative', 'confirmed')
  limit 1;

  if v_assignment.id is null then
    raise exception 'This drive no longer has a driver';
  end if;

  -- Count only children not already riding this trip
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
    if not exists (
      select 1 from public.rider_assignments
      where schedule_version_id = v_version.id
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
      v_trip.group_id, v_version.id, p_trip_id, v_assignment.id, v_child_id
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

-- ── leave_custom_drive ──
-- A parent removes their own child from a custom drive (frees a seat).

create or replace function public.leave_custom_drive(
  p_trip_id uuid,
  p_child_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip public.trips;
  v_group public.groups;
  v_version public.schedule_versions;
  v_child public.children;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  if not exists (
    select 1 from public.memberships
    where profile_id = auth.uid()
      and household_id = v_child.household_id
      and status = 'active'
  ) then
    raise exception 'You can only change rides for your own children';
  end if;

  select * into v_trip from public.trips where id = p_trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  if v_trip.slot <> 'custom' then
    raise exception 'This is not a custom drive';
  end if;

  select * into v_group from public.groups where id = v_trip.group_id;

  if (v_trip.service_date::timestamp + v_trip.meeting_time) at time zone v_group.timezone <= now() then
    raise exception 'That pickup time has already passed';
  end if;

  select * into v_version
  from public.schedule_versions
  where week_id = v_trip.week_id
    and group_id = v_trip.group_id
    and status = 'published'
  order by published_at desc
  limit 1;

  if v_version.id is null then
    raise exception 'The schedule for this week is not published';
  end if;

  delete from public.rider_assignments
  where schedule_version_id = v_version.id
    and trip_id = p_trip_id
    and child_id = p_child_id;

  if not found then
    raise exception 'Ride not found';
  end if;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_trip.group_id, auth.uid(), 'custom_drive_left', 'trip', p_trip_id::text,
    jsonb_build_object('child_id', p_child_id)
  );
end;
$$;

revoke all on function public.leave_custom_drive(uuid, uuid) from public;
grant execute on function public.leave_custom_drive(uuid, uuid) to authenticated;

-- ── cancel_custom_drive ──
-- The offering driver (or a coordinator) cancels a custom drive. The trip
-- row is deleted — FK cascades remove its driver and rider assignments, so
-- every roster read, email, and reminder naturally stops including it.
-- Returns the pre-cancel rider household details so the client can fire
-- the custom_drive_cancelled notifications after the rows are gone.

create or replace function public.cancel_custom_drive(
  p_trip_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip public.trips;
  v_group public.groups;
  v_version public.schedule_versions;
  v_assignment public.driver_assignments;
  v_rider_profile_ids uuid[];
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_trip from public.trips where id = p_trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  if v_trip.slot <> 'custom' then
    raise exception 'Only custom drives can be cancelled here';
  end if;

  if not public.is_group_coordinator(v_trip.group_id) then
    select * into v_assignment
    from public.driver_assignments
    where trip_id = p_trip_id
      and driver_profile_id = auth.uid()
      and status in ('tentative', 'confirmed')
    limit 1;

    if v_assignment.id is null then
      raise exception 'Only the offering driver or a coordinator can cancel this drive';
    end if;
  end if;

  select * into v_group from public.groups where id = v_trip.group_id;

  if (v_trip.service_date::timestamp + v_trip.meeting_time) at time zone v_group.timezone <= now() then
    raise exception 'That pickup time has already passed';
  end if;

  select * into v_version
  from public.schedule_versions
  where week_id = v_trip.week_id
    and group_id = v_trip.group_id
    and status = 'published'
  order by published_at desc
  limit 1;

  if v_version.id is null then
    raise exception 'The schedule for this week is not published';
  end if;

  -- Snapshot rider households before the cascade removes the rows
  select coalesce(array_agg(distinct m.profile_id), '{}') into v_rider_profile_ids
  from public.rider_assignments ra
  join public.children c on c.id = ra.child_id
  join public.memberships m on m.household_id = c.household_id and m.status = 'active'
  where ra.schedule_version_id = v_version.id
    and ra.trip_id = p_trip_id;

  select * into v_assignment
  from public.driver_assignments
  where schedule_version_id = v_version.id
    and trip_id = p_trip_id
  limit 1;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_trip.group_id, auth.uid(), 'custom_drive_cancelled', 'trip', p_trip_id::text,
    jsonb_build_object(
      'service_date', v_trip.service_date,
      'meeting_time', v_trip.meeting_time,
      'direction', v_trip.direction,
      'rider_profile_ids', to_jsonb(v_rider_profile_ids)
    )
  );

  delete from public.trips where id = p_trip_id;

  return jsonb_build_object(
    'driver_profile_id', v_assignment.driver_profile_id,
    'service_date', v_trip.service_date,
    'meeting_time', v_trip.meeting_time,
    'direction', v_trip.direction,
    'origin', v_trip.origin,
    'rider_profile_ids', to_jsonb(v_rider_profile_ids)
  );
end;
$$;

revoke all on function public.cancel_custom_drive(uuid) from public;
grant execute on function public.cancel_custom_drive(uuid) to authenticated;

commit;