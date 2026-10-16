-- Let trusted-group parents coordinate open seats on custom drives.
--
-- Standard-trip placement keeps the existing-ride requirement introduced in
-- 202610120001. Custom drives are different: they are parent-offered seats and
-- do not have ride_request rows. Requiring a target-trip ride request made it
-- impossible to add another household's child to an open custom car.
--
-- A custom placement is a move, not a second ride. In the same transaction we
-- remove any other assignment for that child on the same date + direction,
-- then add the custom seat. Capacity, membership, group, future-date, audit,
-- and notification checks remain in the existing proposal wrapper.

begin;

create or replace function public.place_children_via_crewmate(
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
  v_schedule_version_id uuid;
  v_service_date date;
  v_direction public.trip_direction;
  v_slot text;
  v_vehicle_capacity integer;
  v_seated integer;
  v_to_add integer;
  v_count integer;
  v_unique_count integer;
  v_moves jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  v_count := coalesce(cardinality(p_child_ids), 0);
  if v_count < 1 or v_count > 12 then
    raise exception 'Choose between 1 and 12 children';
  end if;

  select count(distinct child_id)
  into v_unique_count
  from unnest(p_child_ids) as child_id;
  if v_unique_count <> v_count then
    raise exception 'The child list contains duplicates';
  end if;

  select da.group_id, da.schedule_version_id, t.service_date, t.direction,
         t.slot, v.child_passenger_capacity
  into v_group_id, v_schedule_version_id, v_service_date, v_direction,
       v_slot, v_vehicle_capacity
  from public.driver_assignments da
  join public.trips t on t.id = da.trip_id
  join public.vehicles v on v.id = da.vehicle_id and v.active
  where da.id = p_driver_assignment_id
    and da.trip_id = p_trip_id
    and da.status in ('tentative', 'confirmed')
    and t.status <> 'canceled';

  if v_group_id is null then
    raise exception 'That car is not driving this trip';
  end if;
  if v_service_date < current_date then
    raise exception 'Cannot change placement for a past trip';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.group_id = v_group_id
      and m.profile_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'Only an active parent in this carpool can coordinate rider placement';
  end if;

  select count(*) into v_count
  from public.children c
  where c.id = any(p_child_ids)
    and c.group_id = v_group_id
    and c.active;
  if v_count <> cardinality(p_child_ids) then
    raise exception 'Every child must be active in this carpool';
  end if;

  -- Standard schedules still require an existing ride/seat (or the child's
  -- own parent). A custom drive is itself an open-seat offer and therefore
  -- does not have a target-trip ride_request row to satisfy this check.
  if v_slot <> 'custom' and exists (
    select 1
    from unnest(p_child_ids) as requested(child_id)
    where not exists (
      select 1 from public.rider_assignments ra
      where ra.trip_id = p_trip_id and ra.child_id = requested.child_id
    )
    and not exists (
      select 1 from public.ride_requests rr
      where rr.trip_id = p_trip_id
        and rr.child_id = requested.child_id
        and rr.needs_ride
    )
    and not exists (
      select 1
      from public.children c
      join public.memberships m on m.household_id = c.household_id
      where c.id = requested.child_id
        and m.profile_id = v_actor
        and m.status = 'active'
    )
  ) then
    raise exception 'Another household''s child must already need a ride on this trip';
  end if;

  -- Keep the either-preference cross-trip invariant. Moving between early
  -- and late remains the dedicated switch_slot command.
  if v_slot in ('pm_early', 'pm_late') and exists (
    select 1
    from public.rider_assignments ra
    join public.trips t on t.id = ra.trip_id
    where ra.child_id = any(p_child_ids)
      and t.service_date = v_service_date
      and t.slot in ('pm_early', 'pm_late')
      and t.id <> p_trip_id
      and t.status <> 'canceled'
  ) then
    raise exception 'Use a pickup-time change to move a child between afternoon trips';
  end if;

  select count(*) into v_seated
  from public.rider_assignments ra
  where ra.driver_assignment_id = p_driver_assignment_id;

  select count(*) into v_to_add
  from unnest(p_child_ids) as requested(child_id)
  where not exists (
    select 1 from public.rider_assignments ra
    where ra.driver_assignment_id = p_driver_assignment_id
      and ra.child_id = requested.child_id
  );

  if v_seated + v_to_add > v_vehicle_capacity then
    raise exception 'That car has room for % more children, but % were requested',
      greatest(v_vehicle_capacity - v_seated, 0), v_to_add;
  end if;

  -- Snapshot one displaced assignment per changed child for the existing
  -- old/new driver notification contract. For custom destinations, the old
  -- seat may live on a different standard or custom trip that same day.
  select coalesce(jsonb_agg(jsonb_build_object(
    'child_id', requested.child_id,
    'old_assignment_id', old_ra.driver_assignment_id,
    'new_assignment_id', p_driver_assignment_id
  ) order by requested.child_id), '[]'::jsonb)
  into v_moves
  from unnest(p_child_ids) as requested(child_id)
  left join lateral (
    select ra.driver_assignment_id
    from public.rider_assignments ra
    join public.trips old_trip on old_trip.id = ra.trip_id
    where ra.schedule_version_id = v_schedule_version_id
      and ra.child_id = requested.child_id
      and ra.driver_assignment_id <> p_driver_assignment_id
      and (
        ra.trip_id = p_trip_id
        or (
          v_slot = 'custom'
          and old_trip.service_date = v_service_date
          and old_trip.direction = v_direction
        )
      )
    order by (old_trip.slot = 'custom') desc, ra.created_at
    limit 1
  ) old_ra on true
  left join public.rider_assignments target_ra
    on target_ra.schedule_version_id = v_schedule_version_id
   and target_ra.trip_id = p_trip_id
   and target_ra.child_id = requested.child_id
  where target_ra.id is null or old_ra.driver_assignment_id is not null;

  -- Standard placement replaces a seat within the target trip. Custom-drive
  -- placement replaces any other ride for the same date + direction, so the
  -- command cannot silently double-book the child.
  delete from public.rider_assignments ra
  using public.trips old_trip
  where ra.trip_id = old_trip.id
    and ra.schedule_version_id = v_schedule_version_id
    and ra.child_id = any(p_child_ids)
    and ra.driver_assignment_id <> p_driver_assignment_id
    and (
      ra.trip_id = p_trip_id
      or (
        v_slot = 'custom'
        and old_trip.service_date = v_service_date
        and old_trip.direction = v_direction
      )
    );

  insert into public.rider_assignments (
    group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
  )
  select v_group_id, v_schedule_version_id, p_trip_id,
         p_driver_assignment_id, requested.child_id
  from unnest(p_child_ids) as requested(child_id)
  on conflict (schedule_version_id, trip_id, child_id) do update
    set driver_assignment_id = excluded.driver_assignment_id;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_group_id,
    v_actor,
    'crewmate_place_children',
    'driver_assignment',
    p_driver_assignment_id::text,
    jsonb_build_object(
      'trip_id', p_trip_id,
      'child_ids', to_jsonb(p_child_ids),
      'moves', v_moves,
      'vehicle_capacity', v_vehicle_capacity,
      'delegated_parent_placement', true,
      'delegated_custom_drive_placement', v_slot = 'custom'
    )
  );

  return jsonb_build_object('placed', true, 'moves', v_moves);
end;
$$;

revoke all on function public.place_children_via_crewmate(uuid[], uuid, uuid)
  from public, authenticated, service_role;

commit;
