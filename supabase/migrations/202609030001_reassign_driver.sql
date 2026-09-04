-- Admin reassign driver: transfer an assigned drive from one driver to
-- another, moving the riders with it.
--
-- WHY: the DriveDetailScreen "Admin — Reassign driver" feature previously
-- called manually_assign_driver, which is designed for UNCOVERED trips only.
-- It creates a new confirmed assignment and only moves *truly uncovered*
-- children onto it. When a trip already has a driver with riders, the RPC
-- created an EMPTY car for the new driver while the old driver kept every
-- rider — the roster ended up with two drivers and the original still
-- driving. (Seen in production Sep 3, 2026.)
--
-- reassign_driver does what "reassign" means:
--   1. Creates a new confirmed assignment for the target driver.
--   2. Moves ALL rider_assignments from the outgoing assignment to the new
--      one (vehicle capacity is enforced up front).
--   3. Marks the outgoing assignment 'released' — the app renders released
--      as "Another driver took this drive" with a re-accept path.
--   4. Audits 'driver_reassigned' with old/new ids and rider count.
--
-- Coordinator-only, same guard as manually_assign_driver. The target driver
-- must be an active member (no availability check — admin override) and must
-- not already be driving this trip. Vehicle must be active and belong to the
-- target driver's household.

create or replace function public.reassign_driver(
  p_assignment_id uuid,
  p_new_driver_profile_id uuid,
  p_vehicle_id uuid
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.driver_assignments;
  v_trip public.trips;
  v_version public.schedule_versions;
  v_group_id uuid;
  v_is_coordinator boolean;
  v_vehicle public.vehicles;
  v_rider_count integer;
  new_assignment public.driver_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load and lock the outgoing assignment
  select * into v_old from public.driver_assignments where id = p_assignment_id for update;
  if v_old.id is null then
    raise exception 'Assignment not found';
  end if;

  if v_old.status not in ('tentative', 'confirmed') then
    raise exception 'Can only reassign an active (tentative or confirmed) drive';
  end if;

  -- Load trip + version (locks, and proves they still exist)
  select * into v_trip from public.trips where id = v_old.trip_id for update;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  select * into v_version from public.schedule_versions where id = v_old.schedule_version_id for update;
  if v_version.id is null then
    raise exception 'Schedule version not found';
  end if;

  v_group_id := v_trip.group_id;

  -- Caller must be an active coordinator for this group
  select exists(
    select 1 from public.memberships
    where group_id = v_group_id
      and profile_id = auth.uid()
      and role = 'coordinator'
      and status = 'active'
  ) into v_is_coordinator;

  if not v_is_coordinator then
    raise exception 'Only coordinators can reassign drivers';
  end if;

  -- New driver must differ from the outgoing driver
  if p_new_driver_profile_id = v_old.driver_profile_id then
    raise exception 'New driver is the same as the current driver';
  end if;

  -- New driver must be an active member of the group
  -- (no availability check — admin overrides stated availability)
  perform 1 from public.memberships
  where group_id = v_group_id
    and profile_id = p_new_driver_profile_id
    and status = 'active';

  if not found then
    raise exception 'New driver is not an active member of this group';
  end if;

  -- New driver must not already be driving this trip
  perform 1 from public.driver_assignments
  where schedule_version_id = v_old.schedule_version_id
    and trip_id = v_old.trip_id
    and driver_profile_id = p_new_driver_profile_id
    and status in ('tentative', 'confirmed');

  if found then
    raise exception 'New driver is already assigned to this trip';
  end if;

  -- Vehicle must be active and belong to the new driver's household
  select * into v_vehicle from public.vehicles
  where id = p_vehicle_id
    and group_id = v_group_id
    and active = true
    and household_id in (
      select household_id from public.memberships
      where profile_id = p_new_driver_profile_id and status = 'active'
    );

  if v_vehicle.id is null then
    raise exception 'Vehicle not found or does not belong to the new driver';
  end if;

  -- Vehicle must fit the riders being moved (fail fast, don't strand riders)
  select count(*) into v_rider_count
  from public.rider_assignments
  where driver_assignment_id = v_old.id;

  if v_rider_count > v_vehicle.child_passenger_capacity then
    raise exception 'Vehicle too small for current riders';
  end if;

  -- 1. Create the new confirmed assignment
  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  )
  values (
    v_group_id, v_old.schedule_version_id, v_old.trip_id,
    p_new_driver_profile_id, v_vehicle.id, v_vehicle.child_passenger_capacity,
    'confirmed'
  )
  returning * into new_assignment;

  -- 2. Move ALL riders from the outgoing assignment to the new one
  update public.rider_assignments
  set driver_assignment_id = new_assignment.id
  where driver_assignment_id = v_old.id;

  -- 3. Release the outgoing assignment
  update public.driver_assignments
  set status = 'released', updated_at = now()
  where id = v_old.id;

  -- 4. Audit
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_group_id, auth.uid(), 'driver_reassigned', 'driver_assignment',
    new_assignment.id::text,
    jsonb_build_object(
      'trip_id', v_old.trip_id,
      'old_assignment_id', v_old.id,
      'old_driver_profile_id', v_old.driver_profile_id,
      'new_driver_profile_id', p_new_driver_profile_id,
      'riders_moved', v_rider_count,
      'source', 'admin-reassign'
    )
  );

  return new_assignment;
end;
$$;

revoke all on function public.reassign_driver(uuid, uuid, uuid) from public;
grant execute on function public.reassign_driver(uuid, uuid, uuid) to authenticated;