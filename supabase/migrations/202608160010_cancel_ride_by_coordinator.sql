-- Allow a coordinator (group admin) to remove any child from a published drive.
--
-- Mirrors cancel_ride_for_child but gates on the coordinator check instead of
-- the household-membership check. A coordinator can remove any child's rider_assignment
-- from a published schedule, even if the child is not in their household.
--
-- Constraints enforced:
--   - auth.uid() must not be null
--   - The caller must be a coordinator for the child's group (is_group_coordinator)
--   - The child must exist
--   - The driver_assignment must exist
--   - The schedule version must be published (can't modify draft rosters)
--
-- The client sends the driver + family notifications separately via send-push
-- after the RPC succeeds (type = rider_cancelled_by_coordinator).

create or replace function public.cancel_ride_for_child_by_coordinator(
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

  -- Load the child
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  -- Verify the caller is a coordinator for the child's group
  if not public.is_group_coordinator(auth.uid(), v_child.group_id) then
    raise exception 'Only coordinators can remove other children from drives';
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
    v_child.group_id, auth.uid(), 'ride_cancelled_by_coordinator', 'rider_assignment',
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

revoke all on function public.cancel_ride_for_child_by_coordinator(uuid, uuid) from public, authenticated;
grant execute on function public.cancel_ride_for_child_by_coordinator(uuid, uuid) to authenticated;