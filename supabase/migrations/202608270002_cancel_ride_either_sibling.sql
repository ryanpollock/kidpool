-- When a parent removes their child from an afternoon drive with
-- preference='either', also clear the sibling afternoon trip's
-- needs_ride. The parent's intent is "my kid doesn't need an afternoon
-- ride at all" — not "my kid still needs a ride at the other time."

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
  v_trip public.trips;
  v_rr public.ride_requests;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  if not public.is_household_member(v_child.household_id) then
    raise exception 'You can only cancel rides for your own children';
  end if;

  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  delete from public.rider_assignments
  where child_id = p_child_id
    and driver_assignment_id = p_driver_assignment_id;

  if not found then
    raise exception 'Ride not found for this child on this trip';
  end if;

  -- Mark this trip's ride request as not needed
  update public.ride_requests
  set needs_ride = false
  where child_id = p_child_id
    and trip_id = v_assignment.trip_id;

  -- If this was an "either" afternoon trip, also clear the sibling
  select * into v_trip from public.trips where id = v_assignment.trip_id;
  select * into v_rr from public.ride_requests
  where child_id = p_child_id and trip_id = v_assignment.trip_id;

  if v_rr.preference = 'either' and v_trip.direction = 'afternoon' then
    update public.ride_requests
    set needs_ride = false
    where child_id = p_child_id
      and trip_id in (
        select t2.id from public.trips t2
        where t2.service_date = v_trip.service_date
          and t2.direction = 'afternoon'
          and t2.id <> v_trip.id
      );
  end if;

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

-- ── Same fix for coordinator version ──────────────────────────
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
  v_trip public.trips;
  v_rr public.ride_requests;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    raise exception 'Child not found';
  end if;

  if not public.is_group_coordinator(auth.uid(), v_child.group_id) then
    raise exception 'Only coordinators can remove other children from drives';
  end if;

  select * into v_assignment from public.driver_assignments where id = p_driver_assignment_id;
  if v_assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  delete from public.rider_assignments
  where child_id = p_child_id
    and driver_assignment_id = p_driver_assignment_id;

  if not found then
    raise exception 'Ride not found for this child on this trip';
  end if;

  -- Mark this trip's ride request as not needed
  update public.ride_requests
  set needs_ride = false
  where child_id = p_child_id
    and trip_id = v_assignment.trip_id;

  -- If this was an "either" afternoon trip, also clear the sibling
  select * into v_trip from public.trips where id = v_assignment.trip_id;
  select * into v_rr from public.ride_requests
  where child_id = p_child_id and trip_id = v_assignment.trip_id;

  if v_rr.preference = 'either' and v_trip.direction = 'afternoon' then
    update public.ride_requests
    set needs_ride = false
    where child_id = p_child_id
      and trip_id in (
        select t2.id from public.trips t2
        where t2.service_date = v_trip.service_date
          and t2.direction = 'afternoon'
          and t2.id <> v_trip.id
      );
  end if;

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