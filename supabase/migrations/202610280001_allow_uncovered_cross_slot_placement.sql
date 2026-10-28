-- Let an active parent place an uncovered rider into an open car on another
-- trip with the same service date and direction.
--
-- Production incident 2026-10-28: Leah needed the 5:15 PM trip but was
-- uncovered. Junko had an open seat on the 2:10 PM trip. Crewmate correctly
-- proposed the open car, but delegated placement required needs_ride=true on
-- the exact target trip and rejected the confirmation. For an uncovered child
-- this is a placement plus a ride-need transfer, not a move from one assigned
-- car to another.
--
-- The existing placement function remains the invariant-enforcing executor.
-- This wrapper only moves an uncovered same-date/same-direction ride request
-- onto the target trip before calling it. Any later failure rolls the request
-- transfer back with the placement transaction.

begin;

alter function public.place_children_via_crewmate(uuid[], uuid, uuid)
  rename to place_children_via_crewmate_before_cross_slot;

create function public.place_children_via_crewmate(
  p_child_ids uuid[],
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
  v_group_id uuid;
  v_service_date date;
  v_direction public.trip_direction;
  v_slot text;
  v_transferred_child_ids uuid[] := '{}'::uuid[];
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  -- Serialize competing placement cards for the same children. Without this,
  -- two confirmations could both observe an uncovered rider before either
  -- transaction inserts its seat.
  perform 1
  from public.children c
  where c.id = any(p_child_ids)
  order by c.id
  for update;

  select da.group_id, t.service_date, t.direction, t.slot
  into v_group_id, v_service_date, v_direction, v_slot
  from public.driver_assignments da
  join public.trips t on t.id = da.trip_id
  where da.id = p_driver_assignment_id
    and da.trip_id = p_trip_id
    and da.status in ('tentative', 'confirmed')
    and t.status <> 'canceled';

  -- Custom drives already have their own open-seat exception. For standard
  -- trips, transfer only children who are genuinely uncovered: they have a
  -- live ride need on the same date/direction and no seat on any such trip.
  if v_group_id is not null and v_slot <> 'custom' then
    with transfer_source as (
      select requested.child_id, source_request.checkin_id
      from unnest(p_child_ids) as requested(child_id)
      join lateral (
        select rr.checkin_id
        from public.ride_requests rr
        join public.trips source_trip on source_trip.id = rr.trip_id
        where rr.child_id = requested.child_id
          and rr.needs_ride
          and source_trip.group_id = v_group_id
          and source_trip.service_date = v_service_date
          and source_trip.direction = v_direction
          and source_trip.status <> 'canceled'
        order by (source_trip.id = p_trip_id) desc, rr.created_at
        limit 1
      ) source_request on true
      where not exists (
        select 1
        from public.ride_requests target_request
        where target_request.trip_id = p_trip_id
          and target_request.child_id = requested.child_id
          and target_request.needs_ride
      )
      and not exists (
        select 1
        from public.rider_assignments ra
        join public.trips assigned_trip on assigned_trip.id = ra.trip_id
        where ra.child_id = requested.child_id
          and assigned_trip.service_date = v_service_date
          and assigned_trip.direction = v_direction
          and assigned_trip.status <> 'canceled'
      )
    ), transferred as (
      insert into public.ride_requests (
        group_id, checkin_id, trip_id, child_id, needs_ride, created_by
      )
      select v_group_id, transfer_source.checkin_id, p_trip_id,
             transfer_source.child_id, true, v_actor
      from transfer_source
      on conflict (trip_id, child_id) do update
        set needs_ride = true,
            updated_at = now()
      returning child_id
    )
    select coalesce(array_agg(child_id), '{}'::uuid[])
    into v_transferred_child_ids
    from transferred;

    -- A specific placement resolves the prior sibling-trip need. This keeps
    -- uncovered counts and future schedule regeneration aligned with the seat.
    update public.ride_requests rr
    set needs_ride = false,
        updated_at = now()
    from public.trips source_trip
    where cardinality(v_transferred_child_ids) > 0
      and rr.trip_id = source_trip.id
      and rr.child_id = any(v_transferred_child_ids)
      and rr.trip_id <> p_trip_id
      and source_trip.service_date = v_service_date
      and source_trip.direction = v_direction;
  end if;

  -- The original function performs membership, child/group, capacity,
  -- cross-trip assignment, deduplication, notification snapshot, and audit
  -- checks. An exception here rolls back the ride-request transfer above.
  v_result := public.place_children_via_crewmate_before_cross_slot(
    p_child_ids,
    p_trip_id,
    p_driver_assignment_id
  );

  if cardinality(v_transferred_child_ids) > 0 then
    insert into public.audit_events (
      group_id, actor_profile_id, action, entity_type, entity_id, details
    )
    values (
      v_group_id,
      v_actor,
      'crewmate_transfer_uncovered_ride_need',
      'trip',
      p_trip_id::text,
      jsonb_build_object(
        'child_ids', to_jsonb(v_transferred_child_ids),
        'service_date', v_service_date,
        'direction', v_direction,
        'driver_assignment_id', p_driver_assignment_id
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'transferred_ride_need_child_ids', to_jsonb(v_transferred_child_ids)
  );
end;
$$;

revoke all on function public.place_children_via_crewmate_before_cross_slot(uuid[], uuid, uuid)
  from public, authenticated, service_role;
revoke all on function public.place_children_via_crewmate(uuid[], uuid, uuid)
  from public, authenticated, service_role;

commit;
