-- HOT FIX: malformed array literal when executing join_custom_drive /
-- offer_custom_drive proposals.
--
-- Bug: (v_proposal.params ->> 'child_ids')::uuid[] extracts the JSONB array
-- as a TEXT string like ["uuid1","uuid2"] and then tries to cast it to
-- uuid[]. PostgreSQL expects {uuid1,uuid2} format, not JSON array format.
--
-- Fix: use jsonb_array_elements_text(params -> 'child_ids') to properly
-- extract each element as text and aggregate into a uuid[].

create or replace function public.execute_chat_proposal(p_proposal_id uuid)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal public.chat_proposals;
  v_child_id uuid;
  v_trip_id uuid;
  v_assignment_id uuid;
  v_vehicle_id uuid;
  v_da_a uuid;
  v_da_b uuid;
  v_sibling public.chat_proposals;
  v_switch_result jsonb;
  v_exec_result jsonb;
  v_from_date date;
  v_to_date date;
  v_meeting_time time;
  v_departure_time time;
  v_child_ids uuid[];
begin
  select * into v_proposal from public.chat_proposals where id = p_proposal_id;
  if v_proposal.id is null then
    raise exception 'Proposal not found';
  end if;

  v_child_id := v_proposal.params ->> 'child_id';
  v_trip_id := v_proposal.params ->> 'trip_id';
  v_assignment_id := v_proposal.params ->> 'driver_assignment_id';
  v_da_a := v_proposal.params ->> 'assignment_a';
  v_da_b := v_proposal.params ->> 'assignment_b';

  case v_proposal.kind
    when 'cancel_ride' then
      perform public.cancel_ride_for_child(
        (v_proposal.params ->> 'child_id')::uuid,
        (v_proposal.params ->> 'driver_assignment_id')::uuid
      );
    when 'cancel_ride_range' then
      v_from_date := (v_proposal.params ->> 'from_date')::date;
      v_to_date := (v_proposal.params ->> 'to_date')::date;
      if v_child_id is null or v_from_date is null or v_to_date is null then
        raise exception 'Proposal is missing range parameters';
      end if;
      v_exec_result := public.cancel_ride_range_for_child(v_child_id, v_from_date, v_to_date);
    when 'switch_slot' then
      v_switch_result := public.switch_child_afternoon_trip(
        (v_proposal.params ->> 'child_id')::uuid,
        (v_proposal.params ->> 'driver_assignment_id')::uuid
      );
    when 'add_ride' then
      if v_child_id is null or v_trip_id is null then
        raise exception 'Proposal is missing child or trip parameters';
      end if;
      v_exec_result := public.add_ride_request_for_child(v_child_id, v_trip_id);
    when 'place_child' then
      if v_child_id is null or v_trip_id is null or v_assignment_id is null then
        raise exception 'Proposal is missing placement parameters';
      end if;
      v_exec_result := public.place_child_in_vehicle(v_child_id, v_trip_id, v_assignment_id);
    when 'decline_drive' then
      perform public.respond_to_driver_assignment(
        (v_proposal.params ->> 'assignment_id')::uuid,
        'declined',
        v_proposal.params ->> 'decline_reason'
      );
    when 'volunteer_drive' then
      if v_assignment_id is not null then
        perform public.volunteer_for_declined_drive(v_assignment_id);
      elsif v_trip_id is not null then
        perform public.volunteer_for_uncovered_trip(
          v_trip_id,
          (v_proposal.params ->> 'schedule_version_id')::uuid
        );
      else
        raise exception 'Proposal is missing volunteer parameters';
      end if;
    when 'swap_drive' then
      if v_da_a is null or v_da_b is null then
        raise exception 'Proposal is missing swap parameters';
      end if;
      select * into v_sibling
      from public.chat_proposals
      where id = (v_proposal.params ->> 'sibling_proposal_id')::uuid;
      if v_sibling.id is null then
        raise exception 'Swap proposal is missing its linked pair';
      end if;
      if v_sibling.status <> 'confirmed' then
        return v_proposal; -- parked: waiting on the other driver's OK
      end if;
      v_exec_result := public.swap_driver_assignments(v_da_a, v_da_b);
      update public.chat_proposals
      set status = 'executed',
          executed_at = now(),
          executed_result = v_exec_result
      where id in (v_sibling.id, p_proposal_id);
    when 'change_vehicle' then
      if v_assignment_id is null then
        raise exception 'Proposal is missing assignment parameter';
      end if;
      v_vehicle_id := (v_proposal.params ->> 'vehicle_id')::uuid;
      perform public.change_assignment_vehicle(v_assignment_id, v_vehicle_id);
    when 'adjust_times' then
      if v_trip_id is null then
        raise exception 'Proposal is missing trip parameter';
      end if;
      v_meeting_time := (v_proposal.params ->> 'meeting_time')::time;
      v_departure_time := (v_proposal.params ->> 'departure_time')::time;
      perform public.adjust_trip_times(v_trip_id, v_meeting_time, v_departure_time);
    when 'cancel_trip' then
      if v_trip_id is null then
        raise exception 'Proposal is missing trip parameter';
      end if;
      perform public.cancel_trip(v_trip_id);
    when 'offer_custom_drive' then
      -- FIX: extract child_ids from JSONB array properly (jsonb_array_elements_text)
      select array_agg(value::uuid) into v_child_ids
      from jsonb_array_elements_text(v_proposal.params -> 'child_ids');
      v_exec_result := public.offer_custom_drive(
        v_proposal.group_id,
        (v_proposal.params ->> 'service_date')::date,
        (v_proposal.params ->> 'direction')::public.trip_direction,
        (v_proposal.params ->> 'meeting_time')::time,
        coalesce(v_child_ids, '{}'::uuid[])
      );
    when 'join_custom_drive' then
      -- FIX: extract child_ids from JSONB array properly (jsonb_array_elements_text)
      select array_agg(value::uuid) into v_child_ids
      from jsonb_array_elements_text(v_proposal.params -> 'child_ids');
      v_exec_result := public.join_custom_drive(
        v_trip_id,
        coalesce(v_child_ids, '{}'::uuid[])
      );
    when 'leave_custom_drive' then
      perform public.leave_custom_drive(v_trip_id, v_child_id);
    when 'cancel_custom_drive' then
      v_exec_result := public.cancel_custom_drive(v_trip_id);
    when 'admin_sql' then
      perform public.crewmate_admin_sql_execute(
        p_proposal_id,
        v_proposal.group_id,
        auth.uid(),
        v_proposal.params ->> 'sql',
        v_proposal.params -> 'preview'
      );
    else
      raise exception 'Proposal kind % is not supported yet', v_proposal.kind;
  end case;

  return v_proposal;
end;
$$;

revoke all on function public.execute_chat_proposal(uuid) from public, authenticated;