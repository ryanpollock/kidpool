-- Allow parents to cancel (and re-add) their child's ride for a specific trip.
-- Two security-definer RPCs that bypass RLS on rider_assignments, guarded by
-- is_household_member on the child. The cancel RPC deletes the rider_assignment
-- row and records an audit event. The add-back RPC re-inserts it (idempotent via
-- ON CONFLICT DO NOTHING). The client sends the driver notification separately
-- via send-push after the RPC succeeds (matching the cancelDrive pattern).
--
-- Constraints enforced:
--   - auth.uid() must not be null
--   - The child must belong to the caller's household (is_household_member)
--   - The driver_assignment must exist and be active (tentative/confirmed)
--   - The schedule version must be published (can't modify draft rosters)
--   - For add-back: ON CONFLICT DO NOTHING (idempotent — no duplicate rows)

-- ── 1. cancel_ride_for_child ────────────────────────────────────
create or replace function public.cancel_ride_for_child(
  p_child_id uuid,
  p_driver_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_child public.children;
  v_assignment public.driver_assignments;
  v_version public.schedule_versions;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load the child and verify household membership
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  if not public.is_household_member(v_child.household_id) then
    raise exception 'You can only cancel rides for your own children';
  end if;

  -- Load the driver assignment
  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  -- Verify the schedule version is published (can't modify draft rosters)
  select * into v_version from public.schedule_versions where id = v_assignment.schedule_version_id;
  if v_version.status <> 'published' then
    raise exception 'Can only cancel rides on a published schedule';
  end if;

  -- Delete the rider_assignment row
  delete from public.rider_assignments
  where child_id = p_child_id
    and driver_assignment_id = p_driver_assignment_id;

  if not found then
    raise exception 'Ride not found for this child on this trip';
  end if;

  -- Record audit event
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_child.group_id, auth.uid(), 'ride_cancelled', 'rider_assignment',
    p_driver_assignment_id::text,
    jsonb_build_object(
      'child_id', p_child_id,
      'child_name', v_child.first_name || ' ' || v_child.last_name,
      'trip_id', v_assignment.trip_id,
      'driver_assignment_id', p_driver_assignment_id
    )
  );
end;
$$;

revoke all on function public.cancel_ride_for_child(uuid, uuid) from public, authenticated;
grant execute on function public.cancel_ride_for_child(uuid, uuid) to authenticated;

-- ── 2. add_ride_back_for_child ──────────────────────────────────
create or replace function public.add_ride_back_for_child(
  p_child_id uuid,
  p_driver_assignment_id uuid,
  p_trip_id uuid,
  p_schedule_version_id uuid,
  p_group_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_child public.children;
  v_assignment public.driver_assignments;
  v_version public.schedule_versions;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Load the child and verify household membership
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  if not public.is_household_member(v_child.household_id) then
    raise exception 'You can only add rides for your own children';
  end if;

  -- Load the driver assignment and verify it's still active
  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  if v_assignment.status not in ('tentative', 'confirmed') then
    raise exception 'This driver is no longer available for this trip';
  end if;

  -- Verify the schedule version is published
  select * into v_version from public.schedule_versions where id = p_schedule_version_id;
  if v_version.status <> 'published' then
    raise exception 'Can only modify rides on a published schedule';
  end if;

  -- Re-insert the rider_assignment (idempotent — ON CONFLICT DO NOTHING)
  insert into public.rider_assignments (
    group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
  )
  values (
    p_group_id, p_schedule_version_id, p_trip_id, p_driver_assignment_id, p_child_id
  )
  on conflict (schedule_version_id, trip_id, child_id) do nothing;

  -- Record audit event
  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    p_group_id, auth.uid(), 'ride_added_back', 'rider_assignment',
    p_driver_assignment_id::text,
    jsonb_build_object(
      'child_id', p_child_id,
      'child_name', v_child.first_name || ' ' || v_child.last_name,
      'trip_id', p_trip_id
    )
  );
end;
$$;

revoke all on function public.add_ride_back_for_child(uuid, uuid, uuid, uuid, uuid) from public, authenticated;
grant execute on function public.add_ride_back_for_child(uuid, uuid, uuid, uuid, uuid) to authenticated;