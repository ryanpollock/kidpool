-- Crewmate driver reassignment (2026-10-22).
--
-- The app already supports an outgoing driver offering a confirmed drive to
-- another eligible parent. This migration exposes the same guarded transfer
-- to Crewmate in either direction:
--   * outgoing driver asks target to take the drive -> target confirms card
--   * target offers to take outgoing driver's drive -> outgoing confirms card
--
-- The requester has already consented by asking. The other driver is always
-- the required confirmer. Execution remains atomic and re-checks every fact.

begin;

alter table public.chat_proposals
  drop constraint if exists chat_proposals_kind_check;

alter table public.chat_proposals
  add constraint chat_proposals_kind_check check (kind in (
    'cancel_ride', 'switch_slot', 'swap_drive', 'coverage_fill',
    'cancel_ride_range', 'add_ride', 'place_child', 'place_children',
    'decline_drive', 'volunteer_drive', 'reassign_driver', 'change_vehicle',
    'adjust_times', 'cancel_trip', 'admin_sql',
    'offer_custom_drive', 'join_custom_drive', 'leave_custom_drive',
    'cancel_custom_drive'
  ));

create or replace function public.reassign_driver_via_crewmate(
  p_assignment_id uuid,
  p_new_driver_profile_id uuid,
  p_requester_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_confirmer uuid := auth.uid();
  v_old public.driver_assignments;
  v_trip public.trips;
  v_version public.schedule_versions;
  v_vehicle public.vehicles;
  v_new public.driver_assignments;
  v_group_id uuid;
  v_timezone text;
  v_rider_count integer;
  v_is_rider_parent boolean;
  v_is_household_member boolean;
  v_trip_datetime timestamptz;
  v_request public.reassignment_requests;
begin
  if v_confirmer is null then
    raise exception 'Authentication required';
  end if;

  select * into v_old
  from public.driver_assignments
  where id = p_assignment_id
  for update;

  if v_old.id is null then
    raise exception 'Driver assignment not found';
  end if;
  if v_old.status <> 'confirmed' then
    raise exception 'Only a confirmed drive can be reassigned (status: %)', v_old.status;
  end if;
  if p_new_driver_profile_id = v_old.driver_profile_id then
    raise exception 'The replacement driver is already assigned to this drive';
  end if;

  -- Exactly the two affected drivers may authorize this operation. The
  -- requester consented in chat; the proposal confirmer must be the other.
  if not (
    (p_requester_profile_id = v_old.driver_profile_id
      and v_confirmer = p_new_driver_profile_id)
    or
    (p_requester_profile_id = p_new_driver_profile_id
      and v_confirmer = v_old.driver_profile_id)
  ) then
    raise exception 'Both the current and replacement driver must approve this reassignment';
  end if;

  v_group_id := v_old.group_id;

  if not exists (
    select 1 from public.memberships
    where group_id = v_group_id
      and profile_id = p_requester_profile_id
      and status = 'active'
  ) or not exists (
    select 1 from public.memberships
    where group_id = v_group_id
      and profile_id = v_confirmer
      and status = 'active'
  ) then
    raise exception 'Both drivers must be active members of this carpool';
  end if;

  select * into v_trip from public.trips where id = v_old.trip_id for update;
  select * into v_version from public.schedule_versions where id = v_old.schedule_version_id for update;
  select coalesce(timezone, 'America/Los_Angeles') into v_timezone
  from public.groups where id = v_group_id;

  if v_trip.id is null or v_version.id is null then
    raise exception 'Trip or schedule version not found';
  end if;
  if v_version.status <> 'published' then
    raise exception 'Only a published drive can be reassigned';
  end if;

  v_trip_datetime := (v_trip.service_date + v_trip.meeting_time) at time zone v_timezone;
  if v_trip_datetime <= now() then
    raise exception 'This drive has already departed';
  end if;

  if exists (
    select 1 from public.driver_assignments da
    where da.schedule_version_id = v_old.schedule_version_id
      and da.trip_id = v_old.trip_id
      and da.driver_profile_id = p_new_driver_profile_id
      and da.status in ('tentative', 'confirmed')
  ) then
    raise exception 'The replacement driver is already assigned to this trip';
  end if;

  -- Preserve the existing peer-reassignment eligibility rule: the target
  -- must be a rider parent on this car or share the outgoing household.
  select exists (
    select 1
    from public.rider_assignments ra
    join public.children c on c.id = ra.child_id
    join public.memberships m on m.household_id = c.household_id
    where ra.driver_assignment_id = v_old.id
      and m.profile_id = p_new_driver_profile_id
      and m.status = 'active'
  ) into v_is_rider_parent;

  select exists (
    select 1
    from public.memberships m1
    join public.memberships m2 on m2.household_id = m1.household_id
    where m1.profile_id = v_old.driver_profile_id
      and m1.status = 'active'
      and m2.profile_id = p_new_driver_profile_id
      and m2.status = 'active'
  ) into v_is_household_member;

  if not v_is_rider_parent and not v_is_household_member then
    raise exception 'Replacement driver must be a rider parent on this drive or in the current driver''s household';
  end if;

  select count(*) into v_rider_count
  from public.rider_assignments
  where driver_assignment_id = v_old.id;

  if v_rider_count = 0 then
    raise exception 'This drive has no riders remaining';
  end if;

  select v.* into v_vehicle
  from public.vehicles v
  where v.group_id = v_group_id
    and v.household_id in (
      select household_id from public.memberships
      where profile_id = p_new_driver_profile_id and status = 'active'
    )
    and v.active
    and v.child_passenger_capacity >= v_rider_count
  order by v.child_passenger_capacity desc, v.created_at
  limit 1;

  if v_vehicle.id is null then
    raise exception 'Replacement driver does not have an active vehicle with enough seats';
  end if;

  insert into public.driver_assignments (
    group_id, schedule_version_id, trip_id, driver_profile_id,
    vehicle_id, child_passenger_capacity, status
  ) values (
    v_group_id, v_old.schedule_version_id, v_old.trip_id,
    p_new_driver_profile_id, v_vehicle.id,
    v_vehicle.child_passenger_capacity, 'confirmed'
  ) returning * into v_new;

  update public.rider_assignments
  set driver_assignment_id = v_new.id
  where driver_assignment_id = v_old.id;

  update public.driver_assignments
  set status = 'released', updated_at = now()
  where id = v_old.id;

  -- Record the same accepted reassignment object used by the existing app
  -- flow so its mature driver/rider notification pipeline can be reused.
  insert into public.reassignment_requests (
    group_id, assignment_id, target_profile_id, requested_by,
    status, responded_at
  ) values (
    v_group_id, v_old.id, p_new_driver_profile_id,
    v_old.driver_profile_id, 'accepted', now()
  ) returning * into v_request;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  ) values (
    v_group_id,
    v_confirmer,
    'drive_reassigned',
    'driver_assignment',
    v_new.id::text,
    jsonb_build_object(
      'replaced_assignment_id', v_old.id,
      'new_assignment_id', v_new.id,
      'trip_id', v_old.trip_id,
      'original_driver_id', v_old.driver_profile_id,
      'new_driver_id', p_new_driver_profile_id,
      'requester_profile_id', p_requester_profile_id,
      'confirmer_profile_id', v_confirmer,
      'reassignment_request_id', v_request.id,
      'riders_moved', v_rider_count,
      'vehicle', v_vehicle.label,
      'source', 'crewmate'
    )
  );

  return jsonb_build_object(
    'reassigned', true,
    'old_assignment_id', v_old.id,
    'new_assignment_id', v_new.id,
    'request_id', v_request.id,
    'riders_moved', v_rider_count
  );
end;
$$;

revoke all on function public.reassign_driver_via_crewmate(uuid, uuid, uuid)
  from public, authenticated, service_role;

-- Add a narrow wrapper around the current fully featured proposal executor.
alter function public.execute_chat_proposal(uuid)
  rename to execute_chat_proposal_before_driver_reassignment;

create or replace function public.execute_chat_proposal(p_proposal_id uuid)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal public.chat_proposals;
  v_result jsonb;
  v_secret text;
  v_base_url text;
begin
  select * into v_proposal
  from public.chat_proposals
  where id = p_proposal_id;

  if v_proposal.id is null then
    raise exception 'Proposal not found';
  end if;

  if v_proposal.kind <> 'reassign_driver' then
    return public.execute_chat_proposal_before_driver_reassignment(p_proposal_id);
  end if;

  if v_proposal.params ->> 'assignment_id' is null
    or v_proposal.params ->> 'new_driver_profile_id' is null
    or v_proposal.params ->> 'requester_profile_id' is null then
    raise exception 'Proposal is missing reassignment parameters';
  end if;

  v_result := public.reassign_driver_via_crewmate(
    (v_proposal.params ->> 'assignment_id')::uuid,
    (v_proposal.params ->> 'new_driver_profile_id')::uuid,
    (v_proposal.params ->> 'requester_profile_id')::uuid
  );

  if v_proposal.executed_at is null then
    insert into public.audit_events (
      group_id, actor_profile_id, action, entity_type, entity_id, details
    ) values (
      v_proposal.group_id,
      auth.uid(),
      'proposal_fanout',
      'chat_proposal',
      p_proposal_id::text,
      jsonb_build_object(
        'kind', v_proposal.kind,
        'notifications', jsonb_build_array(jsonb_build_object(
          'type', 'reassignment_accepted',
          'request_id', v_result ->> 'request_id'
        ))
      )
    );

    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_secret' limit 1;
    select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;

    if v_secret is not null and v_base_url is not null then
      begin
        perform net.http_post(
          url := v_base_url || '/send-push',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_secret
          ),
          body := jsonb_build_object(
            'type', 'reassignment_accepted',
            'request_id', v_result ->> 'request_id'
          ),
          timeout_milliseconds := 120000
        );
      exception when others then
        raise notice 'Crewmate reassignment fan-out failed: %', sqlerrm;
      end;
    end if;
  end if;

  return v_proposal;
end;
$$;

revoke all on function public.execute_chat_proposal(uuid)
  from public, authenticated;

commit;
