-- Drive reassignment: allow an assigned driver to offer their drive to
-- another eligible parent. The target receives a notification and can
-- accept (drive transfers) or decline (original driver keeps the drive).
--
-- Three RPCs:
--   1. request_drive_reassignment — driver initiates, targets an eligible parent
--   2. respond_to_reassignment_request — target accepts or declines
--   3. cancel_reassignment_request — driver cancels a pending request
--
-- The rider-transfer pattern follows volunteer_for_declined_drive:
--   - Create new confirmed assignment for the target
--   - Move rider_assignments from original to new
--   - Set original to 'released'
--
-- One pending request per assignment (partial unique index).

-- ── Enum ─────────────────────────────────────────────────────
create type public.reassignment_status as enum ('pending', 'accepted', 'declined', 'cancelled');

-- ── Table ────────────────────────────────────────────────────
create table public.reassignment_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  assignment_id uuid not null references public.driver_assignments(id) on delete cascade,
  target_profile_id uuid not null references public.profiles(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  status public.reassignment_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (id, group_id)
);

-- Enforce one pending request per assignment
create unique index reassignment_requests_one_pending
  on public.reassignment_requests (assignment_id)
  where status = 'pending';

-- Fast lookup for incoming requests (home screen)
create index reassignment_requests_target_idx
  on public.reassignment_requests (target_profile_id, status);

-- Fast lookup for outgoing requests (DriveDetailScreen)
create index reassignment_requests_assignment_idx
  on public.reassignment_requests (assignment_id, status);

-- ── RLS ──────────────────────────────────────────────────────
alter table public.reassignment_requests enable row level security;

create policy reassignment_requests_select_group
  on public.reassignment_requests for select to authenticated
  using (public.is_group_member(group_id));

-- No direct write policies — all writes via security-definer RPCs

-- ── RPC 1: request_drive_reassignment ───────────────────────
create or replace function public.request_drive_reassignment(
  p_assignment_id uuid,
  p_target_profile_id uuid
)
returns public.reassignment_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_assignment public.driver_assignments;
  v_trip public.trips;
  v_group_id uuid;
  v_rider_count integer;
  v_target_vehicle public.vehicles;
  v_is_rider_parent integer;
  v_is_household_member integer;
  v_existing_pending integer;
  v_existing_assignment integer;
  v_trip_datetime timestamptz;
  v_request public.reassignment_requests;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load and lock the assignment
  select * into v_assignment
  from public.driver_assignments
  where id = p_assignment_id
  for update;

  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  -- Caller must be the assigned driver
  if v_assignment.driver_profile_id <> auth.uid() then
    raise exception 'Only the assigned driver can request reassignment';
  end if;

  -- Assignment must be confirmed
  if v_assignment.status <> 'confirmed' then
    raise exception 'Only confirmed drives can be reassigned (status: %)', v_assignment.status;
  end if;

  -- Target must not be the caller
  if p_target_profile_id = auth.uid() then
    raise exception 'Cannot reassign to yourself';
  end if;

  -- Check for existing pending request (partial unique index also enforces this)
  select count(*) into v_existing_pending
  from public.reassignment_requests
  where assignment_id = p_assignment_id
    and status = 'pending';

  if v_existing_pending > 0 then
    raise exception 'A pending reassignment request already exists for this drive';
  end if;

  v_group_id := v_assignment.group_id;

  -- Target must be an active member of the group
  perform 1
  from public.memberships
  where group_id = v_group_id
    and profile_id = p_target_profile_id
    and status = 'active';

  if not found then
    raise exception 'Target is not an active member of this group';
  end if;

  -- Target must not already be assigned to drive this trip
  perform 1
  from public.driver_assignments
  where schedule_version_id = v_assignment.schedule_version_id
    and trip_id = v_assignment.trip_id
    and driver_profile_id = p_target_profile_id
    and status in ('tentative', 'confirmed');

  if found then
    raise exception 'Target is already assigned to drive this trip';
  end if;

  -- Trip must be in the future
  select * into v_trip
  from public.trips
  where id = v_assignment.trip_id;

  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  v_trip_datetime := (v_trip.service_date + v_trip.meeting_time) at time zone 'America/Los_Angeles';

  if v_trip_datetime <= now() then
    raise exception 'Cannot reassign a drive that has already departed';
  end if;

  -- Eligibility: target must be either a parent of a child on this drive
  -- OR a member of the requesting driver's own household
  select count(*) into v_is_rider_parent
  from public.rider_assignments ra
  join public.children c on c.id = ra.child_id
  join public.memberships m on m.household_id = c.household_id
  where ra.driver_assignment_id = p_assignment_id
    and m.profile_id = p_target_profile_id
    and m.status = 'active';

  select count(*) into v_is_household_member
  from public.memberships m1
  join public.memberships m2 on m2.household_id = m1.household_id
  where m1.profile_id = auth.uid()
    and m1.status = 'active'
    and m2.profile_id = p_target_profile_id
    and m2.status = 'active';

  if v_is_rider_parent = 0 and v_is_household_member = 0 then
    raise exception 'Target must be a parent of a child on this drive or a member of your household';
  end if;

  -- Target must have an active vehicle with enough seats
  select count(*) into v_rider_count
  from public.rider_assignments
  where driver_assignment_id = p_assignment_id;

  select * into v_target_vehicle
  from public.vehicles
  where group_id = v_group_id
    and household_id in (
      select household_id from public.memberships
      where profile_id = p_target_profile_id and status = 'active'
    )
    and active = true
    and child_passenger_capacity >= v_rider_count
  order by child_passenger_capacity desc
  limit 1;

  if v_target_vehicle.id is null then
    raise exception 'Target does not have a vehicle with enough seats for this drive';
  end if;

  -- Create the request
  insert into public.reassignment_requests (
    group_id, assignment_id, target_profile_id, requested_by, status
  )
  values (
    v_group_id, p_assignment_id, p_target_profile_id, auth.uid(), 'pending'
  )
  returning * into v_request;

  -- Audit
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_group_id, auth.uid(), 'reassignment_requested', 'reassignment_request',
    v_request.id::text,
    jsonb_build_object(
      'assignment_id', p_assignment_id,
      'target_profile_id', p_target_profile_id,
      'trip_id', v_assignment.trip_id
    )
  );

  return v_request;
end;
$$;

revoke all on function public.request_drive_reassignment(uuid, uuid) from public;
grant execute on function public.request_drive_reassignment(uuid, uuid) to authenticated;

-- ── RPC 2: respond_to_reassignment_request ──────────────────
create or replace function public.respond_to_reassignment_request(
  p_request_id uuid,
  p_response text
)
returns public.reassignment_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request public.reassignment_requests;
  v_assignment public.driver_assignments;
  v_trip public.trips;
  v_group_id uuid;
  v_target_vehicle public.vehicles;
  v_rider_count integer;
  v_week_id uuid;
  v_stale_count integer;
  v_trip_datetime timestamptz;
  v_new_assignment public.driver_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_response not in ('accepted', 'declined') then
    raise exception 'Response must be accepted or declined';
  end if;

  -- Load and lock the request
  select * into v_request
  from public.reassignment_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Reassignment request not found';
  end if;

  -- Caller must be the target
  if v_request.target_profile_id <> auth.uid() then
    raise exception 'Only the requested target can respond';
  end if;

  -- Request must be pending
  if v_request.status <> 'pending' then
    raise exception 'This request is no longer pending (status: %)', v_request.status;
  end if;

  v_group_id := v_request.group_id;

  -- ── Decline path ──────────────────────────────────────────
  if p_response = 'declined' then
    update public.reassignment_requests
    set status = 'declined', responded_at = now()
    where id = p_request_id
    returning * into v_request;

    insert into public.audit_events (
      group_id, actor_profile_id, action, entity_type, entity_id, details
    )
    values (
      v_group_id, auth.uid(), 'reassignment_declined', 'reassignment_request',
      v_request.id::text,
      jsonb_build_object('assignment_id', v_request.assignment_id)
    );

    return v_request;
  end if;

  -- ── Accept path — run all acceptance-time guards ─────────

  -- Load and lock the original assignment
  select * into v_assignment
  from public.driver_assignments
  where id = v_request.assignment_id
  for update;

  if v_assignment.id is null then
    raise exception 'Original assignment not found';
  end if;

  -- Guard 1: assignment must still be confirmed
  if v_assignment.status <> 'confirmed' then
    raise exception 'The original driver is no longer assigned to this drive (status: %)', v_assignment.status;
  end if;

  -- Guard 2: assignment's version must be the latest for its week
  select week_id into v_week_id
  from public.schedule_versions
  where id = v_assignment.schedule_version_id;

  select count(*) into v_stale_count
  from public.schedule_versions
  where week_id = v_week_id
    and version_number > (
      select version_number from public.schedule_versions where id = v_assignment.schedule_version_id
    );

  if v_stale_count > 0 then
    raise exception 'The schedule has been updated — please ask the driver to request reassignment again';
  end if;

  -- Guard 3: trip must still be in the future
  select * into v_trip
  from public.trips
  where id = v_assignment.trip_id;

  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;

  v_trip_datetime := (v_trip.service_date + v_trip.meeting_time) at time zone 'America/Los_Angeles';

  if v_trip_datetime <= now() then
    raise exception 'This drive has already departed';
  end if;

  -- Guard 4: target must still have an active vehicle with enough seats
  select count(*) into v_rider_count
  from public.rider_assignments
  where driver_assignment_id = v_assignment.id;

  if v_rider_count = 0 then
    raise exception 'This drive has no riders remaining';
  end if;

  select * into v_target_vehicle
  from public.vehicles
  where group_id = v_group_id
    and household_id in (
      select household_id from public.memberships
      where profile_id = auth.uid() and status = 'active'
    )
    and active = true
    and child_passenger_capacity >= v_rider_count
  order by child_passenger_capacity desc
  limit 1;

  if v_target_vehicle.id is null then
    raise exception 'Your vehicle no longer has enough seats for this drive';
  end if;

  -- Guard 5: target must not already be assigned to drive this trip
  perform 1
  from public.driver_assignments
  where schedule_version_id = v_assignment.schedule_version_id
    and trip_id = v_assignment.trip_id
    and driver_profile_id = auth.uid()
    and status in ('tentative', 'confirmed');

  if found then
    raise exception 'You are already assigned to drive this trip';
  end if;

  -- ── All guards passed — execute the reassignment ─────────

  -- Create new confirmed assignment for the target
  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  )
  values (
    v_group_id, v_assignment.schedule_version_id, v_assignment.trip_id,
    auth.uid(), v_target_vehicle.id, v_target_vehicle.child_passenger_capacity,
    'confirmed'
  )
  returning * into v_new_assignment;

  -- Move rider_assignments from original to new
  update public.rider_assignments
  set driver_assignment_id = v_new_assignment.id
  where driver_assignment_id = v_assignment.id;

  -- Mark original as released
  update public.driver_assignments
  set status = 'released'
  where id = v_assignment.id;

  -- Update request
  update public.reassignment_requests
  set status = 'accepted', responded_at = now()
  where id = p_request_id
  returning * into v_request;

  -- Audit
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_group_id, auth.uid(), 'drive_reassigned', 'driver_assignment',
    v_new_assignment.id::text,
    jsonb_build_object(
      'replaced_assignment_id', v_assignment.id,
      'new_assignment_id', v_new_assignment.id,
      'trip_id', v_assignment.trip_id,
      'original_driver_id', v_assignment.driver_profile_id,
      'new_driver_id', auth.uid(),
      'vehicle', v_target_vehicle.label,
      'source', 'reassignment'
    )
  );

  return v_request;
end;
$$;

revoke all on function public.respond_to_reassignment_request(uuid, text) from public;
grant execute on function public.respond_to_reassignment_request(uuid, text) to authenticated;

-- ── RPC 3: cancel_reassignment_request ──────────────────────
create or replace function public.cancel_reassignment_request(
  p_request_id uuid
)
returns public.reassignment_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request public.reassignment_requests;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
  from public.reassignment_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Reassignment request not found';
  end if;

  -- Only the requester can cancel
  if v_request.requested_by <> auth.uid() then
    raise exception 'Only the requester can cancel this request';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'This request is no longer pending (status: %)', v_request.status;
  end if;

  update public.reassignment_requests
  set status = 'cancelled'
  where id = p_request_id
  returning * into v_request;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_request.group_id, auth.uid(), 'reassignment_cancelled', 'reassignment_request',
    v_request.id::text,
    jsonb_build_object('assignment_id', v_request.assignment_id)
  );

  return v_request;
end;
$$;

revoke all on function public.cancel_reassignment_request(uuid) from public;
grant execute on function public.cancel_reassignment_request(uuid) to authenticated;