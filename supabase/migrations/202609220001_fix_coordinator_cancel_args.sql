-- HOT FIX: cancel_ride_for_child_by_coordinator calls is_group_coordinator
-- with TWO arguments (auth.uid(), group_id) but the function only takes ONE
-- (target_group_id — it checks auth.uid() internally). This causes
-- "function public.is_group_coordinator(uuid, uuid) does not exist" when
-- a coordinator tries to remove a child from a drive.

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
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  -- FIX: single-argument call — is_group_coordinator checks auth.uid() internally
  if not public.is_group_coordinator(v_child.group_id) then
    raise exception 'Only coordinators can remove other children from drives';
  end if;

  perform public.cancel_ride_for_child(p_child_id, p_driver_assignment_id);

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (
    v_child.group_id,
    auth.uid(),
    'cancel_ride_by_coordinator',
    'child',
    p_child_id::text,
    jsonb_build_object('driver_assignment_id', p_driver_assignment_id)
  );
end;
$$;

revoke all on function public.cancel_ride_for_child_by_coordinator(uuid, uuid) from public, authenticated;
grant execute on function public.cancel_ride_for_child_by_coordinator(uuid, uuid) to authenticated;