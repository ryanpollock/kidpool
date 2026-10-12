-- Trusted-group Crewmate placement delegation (2026-10-12).
--
-- A recurring pilot workflow is one parent coordinating several existing
-- riders into a car with open seats. Requiring every rider household to
-- confirm its own card made the chat workflow slower than coordinating the
-- same move by hand. Placement-only proposals may now be confirmed by the
-- requesting active group parent, including one bulk card for several kids.
--
-- This does NOT relax cancellations, new ride requests, driver commitments,
-- vehicle changes, or swaps. The delegated executor is private to the
-- proposal path and preserves trip, capacity, ride-need, dedup, notification,
-- and audit invariants in one transaction.

begin;

alter table public.chat_proposals
  drop constraint if exists chat_proposals_kind_check;

alter table public.chat_proposals
  add constraint chat_proposals_kind_check check (kind in (
    'cancel_ride', 'switch_slot', 'swap_drive', 'coverage_fill',
    'cancel_ride_range', 'add_ride', 'place_child', 'place_children',
    'decline_drive', 'volunteer_drive', 'change_vehicle',
    'adjust_times', 'cancel_trip', 'admin_sql',
    'offer_custom_drive', 'join_custom_drive', 'leave_custom_drive',
    'cancel_custom_drive'
  ));

-- Private bulk placement executor. It is intentionally not granted to
-- authenticated/service_role: only execute_chat_proposal (owned by postgres)
-- can call it after the proposal confirmation gate has authenticated the
-- requesting parent.
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

  select da.group_id, da.schedule_version_id, t.service_date, t.slot,
         v.child_passenger_capacity
  into v_group_id, v_schedule_version_id, v_service_date, v_slot,
       v_vehicle_capacity
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

  -- A trusted parent may coordinate another household's EXISTING ride, but
  -- may not create a surprise ride need for them. Preserve the prior behavior
  -- that a child's own parent may place their child before a ride-request row
  -- exists.
  if exists (
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

  -- Snapshot the old/new assignment per changed child for audit and fan-out.
  select coalesce(jsonb_agg(jsonb_build_object(
    'child_id', requested.child_id,
    'old_assignment_id', old_ra.driver_assignment_id,
    'new_assignment_id', p_driver_assignment_id
  ) order by requested.child_id), '[]'::jsonb)
  into v_moves
  from unnest(p_child_ids) as requested(child_id)
  left join public.rider_assignments old_ra
    on old_ra.trip_id = p_trip_id and old_ra.child_id = requested.child_id
  where old_ra.driver_assignment_id is distinct from p_driver_assignment_id;

  delete from public.rider_assignments ra
  where ra.trip_id = p_trip_id
    and ra.child_id = any(p_child_ids)
    and ra.driver_assignment_id <> p_driver_assignment_id;

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
      'delegated_parent_placement', true
    )
  );

  return jsonb_build_object('placed', true, 'moves', v_moves);
end;
$$;

revoke all on function public.place_children_via_crewmate(uuid[], uuid, uuid)
  from public, authenticated, service_role;

-- Preserve the fully featured executor (including fan-out) as the legacy
-- implementation, then intercept only placement proposals in a small wrapper.
alter function public.execute_chat_proposal(uuid)
  rename to execute_chat_proposal_before_delegated_placement;

create or replace function public.execute_chat_proposal(p_proposal_id uuid)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal public.chat_proposals;
  v_child_ids uuid[];
  v_result jsonb;
  v_move jsonb;
  v_notifications jsonb := '[]'::jsonb;
  v_note record;
  v_secret text;
  v_base_url text;
begin
  select * into v_proposal
  from public.chat_proposals
  where id = p_proposal_id;

  if v_proposal.id is null then
    raise exception 'Proposal not found';
  end if;

  if v_proposal.kind not in ('place_child', 'place_children') then
    return public.execute_chat_proposal_before_delegated_placement(p_proposal_id);
  end if;

  if v_proposal.kind = 'place_child' then
    v_child_ids := array[(v_proposal.params ->> 'child_id')::uuid];
  else
    select array_agg(value::uuid) into v_child_ids
    from jsonb_array_elements_text(v_proposal.params -> 'child_ids');
  end if;

  if coalesce(cardinality(v_child_ids), 0) = 0
    or v_proposal.params ->> 'trip_id' is null
    or v_proposal.params ->> 'driver_assignment_id' is null then
    raise exception 'Proposal is missing placement parameters';
  end if;

  v_result := public.place_children_via_crewmate(
    v_child_ids,
    (v_proposal.params ->> 'trip_id')::uuid,
    (v_proposal.params ->> 'driver_assignment_id')::uuid
  );

  for v_move in select value from jsonb_array_elements(v_result -> 'moves') loop
    if v_move ->> 'old_assignment_id' is not null then
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'rider_switched_old',
        'assignment_id', v_move ->> 'old_assignment_id',
        'child_id', v_move ->> 'child_id'
      );
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'rider_switched_new',
        'assignment_id', v_move ->> 'new_assignment_id',
        'child_id', v_move ->> 'child_id'
      );
    else
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'rider_added',
        'assignment_id', v_move ->> 'new_assignment_id',
        'child_id', v_move ->> 'child_id'
      );
    end if;

    -- Approval is relaxed, not transparency: tell the child's household
    -- which parent coordinated the move.
    v_notifications := v_notifications || jsonb_build_object(
      'type', 'rider_reassigned_by_parent',
      'trip_id', v_proposal.params ->> 'trip_id',
      'assignment_id', v_move ->> 'new_assignment_id',
      'child_id', v_move ->> 'child_id',
      'actor_profile_id', auth.uid()
    );
  end loop;

  if v_proposal.executed_at is null
    and jsonb_array_length(v_notifications) > 0 then
    insert into public.audit_events (
      group_id, actor_profile_id, action, entity_type, entity_id, details
    )
    values (
      v_proposal.group_id,
      auth.uid(),
      'proposal_fanout',
      'chat_proposal',
      p_proposal_id::text,
      jsonb_build_object('kind', v_proposal.kind, 'notifications', v_notifications)
    );

    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_secret' limit 1;
    select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'cron_edge_base_url' limit 1;

    if v_secret is not null and v_base_url is not null then
      for v_note in select value as note_body
        from jsonb_array_elements(v_notifications)
      loop
        begin
          perform net.http_post(
            url := v_base_url || '/send-push',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'Authorization', 'Bearer ' || v_secret
            ),
            body := v_note.note_body,
            timeout_milliseconds := 120000
          );
        exception when others then
          raise notice 'delegated placement fan-out post failed: %', sqlerrm;
        end;
      end loop;
    end if;
  end if;

  return v_proposal;
end;
$$;

revoke all on function public.execute_chat_proposal(uuid)
  from public, authenticated;

commit;
