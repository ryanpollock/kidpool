-- Custom-drive offers require a published schedule (decision 2026-09-26/27).
--
-- Reverses, for OFFERS ONLY, the "any juncture" relaxation from
-- 202609130001: parents can no longer offer an extra drive before the
-- week's schedule is published. If the 202609130001 behavior had been kept,
-- the first offer of a week with no schedule version seeded a placeholder
-- 'manual-v1' draft that (a) misrepresented the app's state to coordinators
-- ("a draft exists on Saturday that nobody generated"), (b) became
-- publishable by the coordinator paths, and (c) would be published by the
-- Sunday 7 PM auto-publish as the week's "schedule" if the 7 AM generation
-- ever failed silently — a nearly empty roster instead of a loud failure.
-- Observed in production on 2026-09-26: a Saturday offer seeded manual v1,
-- confused the coordinator into a reactive manual generate, and 18
-- confirmation requests went out a day early against a partial draft.
--
-- The guard and phrasing are restored from 202609100002 (the original
-- custom drives migration): the offer must attach to the week's PUBLISHED
-- schedule version. Join / leave / cancel keep the 202609130001 resolution
-- rule (published → latest draft → null) so drives offered before this
-- change remains fully manageable.
--
-- The client still renders the offer button pre-publish but disables it
-- with an explainer ("opens Sunday evening, once the weekly schedule is
-- published"). Crewmate's offer_custom_drive proposal execution calls this
-- RPC by name, so it inherits the guard with no Crewmate SQL changes.

begin;

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
  v_version_id uuid;
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

  -- Extra drives extend the PUBLISHED roster. No published version yet
  -- (Saturday through Sunday 7 PM Pacific) → no offers. This is the exact
  -- guard from 202609100002, restored per the 2026-09-26/27 policy revert.
  select id into v_version_id
  from public.schedule_versions
  where week_id = v_week.id
    and group_id = p_group_id
    and status = 'published'
  order by published_at desc
  limit 1;

  if v_version_id is null then
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
    p_group_id, v_version_id, v_trip.id, auth.uid(),
    v_vehicle.id, v_vehicle.child_passenger_capacity, 'confirmed'
  )
  returning * into v_assignment;

  -- Own children as initial riders
  foreach v_child_id in array p_child_ids loop
    insert into public.rider_assignments (
      group_id, schedule_version_id, trip_id, driver_assignment_id, child_id
    )
    values (
      p_group_id, v_version_id, v_trip.id, v_assignment.id, v_child_id
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

commit;