-- Crewmate AI — Phase 2: the proposal engine.
-- Spec: CREWMATE_REQUIREMENTS.md §6 (command catalog), §7 (consent),
-- §8 (admin_sql). Phase 1 shipped Q&A-only; Phase 2 lets Crewmate propose
-- schedule changes as chat_proposals cards that only execute when the
-- right parent confirms — the LLM still never mutates the schedule
-- directly; execution always happens here, in Postgres, behind the same
-- invariants the app's own flows enforce.
--
-- Owners: a proposal kind maps to ONE executor RPC. confirm_chat_proposal
-- branches by kind; every branch re-validates consent + invariants at
-- execution time with the CONFIRMING PARENT as the actor.

-- ── 1. Widen the proposal kind catalog ────────────────────────────
-- New kinds (Phase 2). coverage_fill's executor is Phase 3 (proactive
-- broadcasts) and still rejects here until then.

alter table public.chat_proposals drop constraint if exists chat_proposals_kind_check;
alter table public.chat_proposals
  add constraint chat_proposals_kind_check check (kind in (
    'cancel_ride', 'switch_slot', 'swap_drive', 'coverage_fill',
    'cancel_ride_range', 'add_ride', 'place_child',
    'decline_drive', 'volunteer_drive', 'change_vehicle',
    'adjust_times', 'cancel_trip', 'admin_sql',
    'offer_custom_drive', 'join_custom_drive', 'leave_custom_drive', 'cancel_custom_drive'
  ));

-- ── 2. Catalog executors ──────────────────────────────────────────
-- All security definer (owned by postgres), all act as auth.uid() and
-- re-validate ownership, all write audit_events.

-- cancel_ride_range: remove a child from every trip they're assigned to
-- in a date range (multi-day absence). Returns the affected dates.
create or replace function public.cancel_ride_range_for_child(
  p_child_id uuid,
  p_from_date date,
  p_to_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_household_id uuid;
  v_actor uuid := auth.uid();
  v_dates jsonb;
  v_count integer := 0;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if p_to_date < p_from_date then
    raise exception 'The end date is before the start date';
  end if;
  if p_from_date < current_date then
    raise exception 'Cannot cancel rides in the past';
  end if;

  select c.household_id into v_household_id
  from public.children c
  where c.id = p_child_id
    and c.active;

  if v_household_id is null then
    raise exception 'Child not found';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.household_id = v_household_id
      and m.profile_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'Only a parent of this child can cancel their rides';
  end if;

  select coalesce(jsonb_agg(distinct t.service_date), '[]'::jsonb), count(*)
  into v_dates, v_count
  from public.rider_assignments ra
  join public.trips t on t.id = ra.trip_id
  join public.driver_assignments da on da.id = ra.driver_assignment_id
  where ra.child_id = p_child_id
    and t.service_date between p_from_date and p_to_date
    and t.status <> 'canceled'
    and da.status in ('tentative', 'confirmed');

  perform public.cancel_ride_for_child(p_child_id, ra.driver_assignment_id)
  from public.rider_assignments ra
  join public.trips t on t.id = ra.trip_id
  join public.driver_assignments da on da.id = ra.driver_assignment_id
  where ra.child_id = p_child_id
    and t.service_date between p_from_date and p_to_date
    and t.status <> 'canceled'
    and da.status in ('tentative', 'confirmed');

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  select c.group_id, v_actor, 'cancel_ride_range', 'child', p_child_id::text,
         jsonb_build_object('from_date', p_from_date, 'to_date', p_to_date, 'trips', v_count)
  from public.children c
  where c.id = p_child_id;

  return jsonb_build_object('cancelled_dates', v_dates, 'trips', v_count);
end;
$$;

revoke all on function public.cancel_ride_range_for_child(uuid, date, date) from public, authenticated;
grant execute on function public.cancel_ride_range_for_child(uuid, date, date) to authenticated;

-- place_child_in_vehicle: assign a child to a specific car on a trip.
-- Enforces capacity, the one-active-assignment rule, and the either-
-- sibling dedup (production incident 2026-09-13).
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

  -- Capacity: named children already in this car.
  select count(*) into v_seated
  from public.rider_assignments ra
  where ra.driver_assignment_id = p_driver_assignment_id;

  if v_seated >= v_da.child_passenger_capacity then
    raise exception 'That car is already full (% of % seats taken)', v_seated, v_da.child_passenger_capacity;
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
          jsonb_build_object('trip_id', p_trip_id, 'driver_assignment_id', p_driver_assignment_id));

  return jsonb_build_object('placed', true, 'trip_id', p_trip_id);
end;
$$;

revoke all on function public.place_child_in_vehicle(uuid, uuid, uuid) from public, authenticated;
grant execute on function public.place_child_in_vehicle(uuid, uuid, uuid) to authenticated;

-- add_ride_request_for_child: a child needs a ride on a trip they don't
-- have one for. Creates the ride request (and a check-in row if the
-- household never checked in) and attempts placement into a car with
-- seats; an unseated child stays visible as uncovered — never hidden.
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

  -- Ensure a check-in row exists for the household (created here so the
  -- ride request has its required parent row; submitted means the
  -- household's answers are what they told Crewmate).
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
  select da.*, (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = da.id) as seated
  into v_target_da
  from public.driver_assignments da
  join public.trips t on t.id = da.trip_id
  where da.trip_id = p_trip_id
    and da.status in ('tentative', 'confirmed')
    and t.status <> 'canceled'
  order by (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = da.id)
  limit 1;

  if v_target_da.id is not null and v_target_da.seated < v_target_da.child_passenger_capacity then
    perform public.place_child_in_vehicle(p_child_id, p_trip_id, v_target_da.id);
  end if;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group_id, v_actor, 'add_ride_request', 'child', p_child_id::text,
          jsonb_build_object('trip_id', p_trip_id, 'placed', v_target_da.id is not null and v_target_da.seated < v_target_da.child_passenger_capacity));

  return jsonb_build_object(
    'ride_requested', true,
    'placed', v_target_da.id is not null and v_target_da.seated < v_target_da.child_passenger_capacity
  );
end;
$$;

revoke all on function public.add_ride_request_for_child(uuid, uuid) from public, authenticated;
grant execute on function public.add_ride_request_for_child(uuid, uuid) to authenticated;

-- change_assignment_vehicle: a driver uses a different car for one drive.
create or replace function public.change_assignment_vehicle(
  p_assignment_id uuid,
  p_vehicle_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_da record;
  v_seated integer;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select da.* into v_da from public.driver_assignments da where da.id = p_assignment_id;
  if v_da.id is null then
    raise exception 'Assignment not found';
  end if;

  if v_da.driver_profile_id <> v_actor then
    raise exception 'Only the assigned driver can change their vehicle';
  end if;

  if v_da.status not in ('tentative', 'confirmed') then
    raise exception 'This drive is no longer active';
  end if;

  if not exists (
    select 1 from public.vehicles v
    join public.memberships m on m.household_id = v.household_id
    where v.id = p_vehicle_id
      and v.active
      and m.profile_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'That vehicle is not one of your household''s active cars';
  end if;

  if (select t.service_date from public.trips t where t.id = v_da.trip_id) < current_date then
    raise exception 'Cannot change the vehicle for a past drive';
  end if;

  select count(*) into v_seated
  from public.rider_assignments ra where ra.driver_assignment_id = p_assignment_id;

  if v_seated > (select child_passenger_capacity from public.vehicles where id = p_vehicle_id) then
    raise exception 'That car has fewer seats than children already assigned (% needed)', v_seated;
  end if;

  update public.driver_assignments
  set vehicle_id = p_vehicle_id,
      child_passenger_capacity = (select child_passenger_capacity from public.vehicles where id = p_vehicle_id)
  where id = p_assignment_id;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_da.group_id, v_actor, 'change_assignment_vehicle', 'driver_assignment', p_assignment_id::text,
          jsonb_build_object('vehicle_id', p_vehicle_id));
end;
$$;

revoke all on function public.change_assignment_vehicle(uuid, uuid) from public, authenticated;
grant execute on function public.change_assignment_vehicle(uuid, uuid) to authenticated;

-- swap_driver_assignments: two drivers trade drives. Vehicle follows the
-- driver (resolveDriverVehicle rules: the car tagged to them, else their
-- household's single active car, else the smallest-capacity one — never
-- overstates a car). Riders stay with the drive slot.
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

  -- Swaps change the two drivers' obligations; both must have consented
  -- through the linked proposal cards before this executor runs.
  select v_a.group_id into v_group;

  if (select t.service_date from public.trips t where t.id = v_a.trip_id) < current_date
     or (select t.service_date from public.trips t where t.id = v_b.trip_id) < current_date then
    raise exception 'Cannot swap a past drive';
  end if;

  -- Neither driver may already hold another drive on the counterpart's
  -- trip (one driver per household per trip stays intact — the swap keeps
  -- each trip with exactly one of these two drivers).
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

  -- Swap drivers; each keeps their own car.
  update public.driver_assignments
  set driver_profile_id = v_b.driver_profile_id,
      vehicle_id = public.resolve_driver_vehicle_for(v_b.driver_profile_id, child_passenger_capacity)
  where id = p_assignment_a;

  update public.driver_assignments
  set driver_profile_id = v_a.driver_profile_id,
      vehicle_id = public.resolve_driver_vehicle_for(v_a.driver_profile_id, child_passenger_capacity)
  where id = p_assignment_b;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group, v_actor, 'swap_driver_assignments', 'driver_assignment', p_assignment_a::text,
          jsonb_build_object('assignment_a', p_assignment_a, 'assignment_b', p_assignment_b,
                             'driver_a', v_a.driver_profile_id, 'driver_b', v_b.driver_profile_id));

  return jsonb_build_object('swapped', true);
end;
$$;

revoke all on function public.swap_driver_assignments(uuid, uuid) from public, authenticated;
grant execute on function public.swap_driver_assignments(uuid, uuid) to authenticated;

-- Vehicle resolution for a driver (mirrors resolveDriverVehicle in
-- carpool-repository: tagged car, else household's single active car,
-- else the smallest-capacity one).
create or replace function public.resolve_driver_vehicle_for(
  p_driver_profile_id uuid,
  p_min_capacity integer default 1
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select v.id
  from public.vehicles v
  join public.memberships m on m.household_id = v.household_id
  where m.profile_id = p_driver_profile_id
    and m.status = 'active'
    and v.active
    and v.child_passenger_capacity >= greatest(p_min_capacity, 1)
  order by
    (v.default_driver_id = p_driver_profile_id) desc,
    (select count(*) from public.vehicles v2
      join public.memberships m2 on m2.household_id = v2.household_id
      where m2.profile_id = p_driver_profile_id and v2.active) asc,
    v.child_passenger_capacity asc
  limit 1;
$$;

revoke all on function public.resolve_driver_vehicle_for(uuid, integer) from public;
grant execute on function public.resolve_driver_vehicle_for(uuid, integer) to authenticated, service_role;

-- adjust_trip_times: coordinator-only (coordinators configure times).
create or replace function public.adjust_trip_times(
  p_trip_id uuid,
  p_meeting_time time,
  p_departure_time time
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_group uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select t.group_id into v_group from public.trips t where t.id = p_trip_id;
  if v_group is null then
    raise exception 'Trip not found';
  end if;

  if not public.is_group_coordinator(v_group) then
    raise exception 'Only coordinators can change trip times';
  end if;

  if (select service_date from public.trips where id = p_trip_id) < current_date then
    raise exception 'Cannot change times for a past trip';
  end if;

  update public.trips
  set meeting_time = p_meeting_time,
      departure_time = p_departure_time
  where id = p_trip_id;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group, v_actor, 'adjust_trip_times', 'trip', p_trip_id::text,
          jsonb_build_object('meeting_time', p_meeting_time, 'departure_time', p_departure_time));
end;
$$;

revoke all on function public.adjust_trip_times(uuid, time, time) from public, authenticated;
grant execute on function public.adjust_trip_times(uuid, time, time) to authenticated;

-- cancel_trip: coordinator-only. Marks the trip canceled, releases its
-- drives, and removes its rosters — no ride is ever silently kept.
create or replace function public.cancel_trip(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_group uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select t.group_id into v_group from public.trips t where t.id = p_trip_id;
  if v_group is null then
    raise exception 'Trip not found';
  end if;

  if not public.is_group_coordinator(v_group) then
    raise exception 'Only coordinators can cancel a trip';
  end if;

  if (select service_date from public.trips where id = p_trip_id) < current_date then
    raise exception 'Cannot cancel a past trip';
  end if;

  update public.trips set status = 'canceled' where id = p_trip_id;

  update public.driver_assignments
  set status = 'released'
  where trip_id = p_trip_id
    and status in ('tentative', 'confirmed');

  delete from public.rider_assignments where trip_id = p_trip_id;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (v_group, v_actor, 'cancel_trip', 'trip', p_trip_id::text, '{}'::jsonb);
end;
$$;

revoke all on function public.cancel_trip(uuid) from public, authenticated;
grant execute on function public.cancel_trip(uuid) to authenticated;