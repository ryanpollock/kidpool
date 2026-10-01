-- Proposal execution fan-out + proposal-created push (2026-09-30).
--
-- Production defect: when a Crewmate card EXECUTES, affected parties got
-- nothing. The app's manual flows notify people — rider_cancelled to the
-- driver, declined to rider households, rider_switched_old/new on slot
-- changes, custom_drive_* — but those pushes are fired by CLIENT UI code,
-- and the confirm path only calls the RPC. So the same action that
-- notifies everyone when done by hand was completely silent when done
-- through Crewmate (production example: "Assign Elinore Y to Jessica
-- Archer Nuzzo's car Monday morning" executed in Tiffany's private
-- Crewmate thread — Jessica never saw the card and was never told).
--
-- Fix (parity): execute_chat_proposal now collects a per-kind notification
-- batch and POSTs each entry to send-push via the established vault-secret
-- pg_net pattern (fail-soft). Reused types carry the same bodies the client
-- fires; two new types cover semantics that had no manual equivalent:
--   rider_added  — driver whose car gains a child (place_child / add_ride)
--   drive_swapped — both drivers on a swap
-- Deferred by design (no manual precedent, coordinator-gated, unused):
-- adjust_times, cancel_trip, change_vehicle, admin_sql (never).
--
-- Observability: every batch is audited (action='proposal_fanout') so
-- QA and support can see exactly who was told, and a re-run of a proposal
-- that already executed (executed_at set) is belt-guarded from
-- double-sending. Parked swaps return before the fan-out, so only real
-- executions notify.
--
-- The companion chat-agent change pushes the REQUIRED CONFIRMER when a
-- card is created and the confirmer isn't the asker (type proposal_created,
-- deep link to the thread) — closing "in the dark about whether a card
-- was posted".

begin;

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
  v_notifications jsonb := '[]'::jsonb;
  v_note record;
  v_secret text;
  v_base_url text;
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
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'rider_cancelled',
        'assignment_id', (v_proposal.params ->> 'driver_assignment_id'),
        'child_id', v_child_id
      );
    when 'cancel_ride_range' then
      v_from_date := (v_proposal.params ->> 'from_date')::date;
      v_to_date := (v_proposal.params ->> 'to_date')::date;
      if v_child_id is null or v_from_date is null or v_to_date is null then
        raise exception 'Proposal is missing range parameters';
      end if;
      -- Snapshot the affected assignments BEFORE the cancel loop deletes
      -- the rider rows (mirrors cancel_ride_range_for_child's own scoping).
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'type', 'rider_cancelled',
          'assignment_id', ra.driver_assignment_id,
          'child_id', v_child_id
        )),
        '[]'::jsonb
      ) into v_notifications
      from public.rider_assignments ra
      join public.trips t on t.id = ra.trip_id
      join public.driver_assignments da on da.id = ra.driver_assignment_id
      where ra.child_id = v_child_id
        and t.service_date between v_from_date and v_to_date
        and t.status <> 'canceled'
        and da.status in ('tentative', 'confirmed');
      v_exec_result := public.cancel_ride_range_for_child(v_child_id, v_from_date, v_to_date);
    when 'switch_slot' then
      v_switch_result := public.switch_child_afternoon_trip(
        (v_proposal.params ->> 'child_id')::uuid,
        (v_proposal.params ->> 'driver_assignment_id')::uuid
      );
      if v_switch_result ->> 'old_driver_assignment_id' is not null then
        v_notifications := v_notifications || jsonb_build_object(
          'type', 'rider_switched_old',
          'assignment_id', v_switch_result ->> 'old_driver_assignment_id',
          'child_id', v_child_id
        );
      end if;
      if v_switch_result ->> 'new_driver_assignment_id' is not null then
        v_notifications := v_notifications || jsonb_build_object(
          'type', 'rider_switched_new',
          'assignment_id', v_switch_result ->> 'new_driver_assignment_id',
          'child_id', v_child_id
        );
      end if;
    when 'add_ride' then
      if v_child_id is null or v_trip_id is null then
        raise exception 'Proposal is missing child or trip parameters';
      end if;
      v_exec_result := public.add_ride_request_for_child(v_child_id, v_trip_id);
      -- If the child was seated, tell the driver whose car gained them.
      select ra.driver_assignment_id into v_assignment_id
      from public.rider_assignments ra
      where ra.child_id = v_child_id and ra.trip_id = v_trip_id
      limit 1;
      if v_assignment_id is not null then
        v_notifications := v_notifications || jsonb_build_object(
          'type', 'rider_added',
          'assignment_id', v_assignment_id,
          'child_id', v_child_id
        );
      end if;
    when 'place_child' then
      if v_child_id is null or v_trip_id is null or v_assignment_id is null then
        raise exception 'Proposal is missing placement parameters';
      end if;
      v_exec_result := public.place_child_in_vehicle(v_child_id, v_trip_id, v_assignment_id);
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'rider_added',
        'assignment_id', v_assignment_id,
        'child_id', v_child_id
      );
    when 'decline_drive' then
      perform public.respond_to_driver_assignment(
        (v_proposal.params ->> 'assignment_id')::uuid,
        'declined',
        v_proposal.params ->> 'decline_reason'
      );
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'declined',
        'assignment_id', (v_proposal.params ->> 'assignment_id')
      );
    when 'volunteer_drive' then
      if v_assignment_id is not null then
        perform public.volunteer_for_declined_drive(v_assignment_id);
        v_notifications := v_notifications || jsonb_build_object(
          'type', 'volunteered',
          'assignment_id', v_assignment_id
        );
      elsif v_trip_id is not null then
        -- volunteer_for_uncovered_trip creates a NEW assignment; capture
        -- its row so the rider households can be pointed at the right car.
        v_exec_result := to_jsonb(public.volunteer_for_uncovered_trip(
          v_trip_id,
          (v_proposal.params ->> 'schedule_version_id')::uuid
        ));
        if v_exec_result ->> 'id' is not null then
          v_notifications := v_notifications || jsonb_build_object(
            'type', 'volunteered',
            'assignment_id', v_exec_result ->> 'id'
          );
        end if;
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
        return v_proposal;
      end if;
      v_exec_result := public.swap_driver_assignments(v_da_a, v_da_b);
      update public.chat_proposals
      set status = 'executed',
          executed_at = now(),
          executed_result = v_exec_result
      where id in (v_sibling.id, p_proposal_id);
      -- A swap that executed once is done. Any OTHER live swap proposal
      -- for the same two drives (a duplicate pair from a re-ask, or a
      -- parallel request in another thread) must not survive to be
      -- confirmed later — its execution would swap the drives BACK
      -- (production incident 2026-09-29).
      update public.chat_proposals
      set status = 'declined',
          failure_reason = 'superseded — this swap already happened',
          updated_at = now()
      where kind = 'swap_drive'
        and group_id = v_proposal.group_id
        and status in ('pending', 'confirmed')
        and id not in (v_sibling.id, p_proposal_id)
        and (
          (params ->> 'assignment_a' = v_da_a::text and params ->> 'assignment_b' = v_da_b::text)
          or (params ->> 'assignment_a' = v_da_b::text and params ->> 'assignment_b' = v_da_a::text)
        );
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'drive_swapped',
        'assignment_a', v_da_a,
        'assignment_b', v_da_b
      );
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
      -- offer_custom_drive returns driver_assignments (row type), not jsonb.
      -- Wrap in to_jsonb for the executed_result. child_ids extracted from
      -- JSONB properly (jsonb_array_elements_text, not ->>::uuid[]).
      select array_agg(value::uuid) into v_child_ids
      from jsonb_array_elements_text(v_proposal.params -> 'child_ids');
      v_exec_result := to_jsonb(public.offer_custom_drive(
        v_proposal.group_id,
        (v_proposal.params ->> 'service_date')::date,
        (v_proposal.params ->> 'direction')::public.trip_direction,
        (v_proposal.params ->> 'meeting_time')::time,
        coalesce(v_child_ids, '{}'::uuid[])
      ));
      if v_exec_result ->> 'trip_id' is not null then
        v_notifications := v_notifications || jsonb_build_object(
          'type', 'custom_drive_offered',
          'trip_id', v_exec_result ->> 'trip_id'
        );
      end if;
    when 'join_custom_drive' then
      -- join_custom_drive returns void — use PERFORM, not assignment.
      -- Assigning void to jsonb causes "invalid input syntax for type json".
      select array_agg(value::uuid) into v_child_ids
      from jsonb_array_elements_text(v_proposal.params -> 'child_ids');
      perform public.join_custom_drive(
        v_trip_id,
        coalesce(v_child_ids, '{}'::uuid[])
      );
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'custom_drive_joined',
        'trip_id', v_trip_id,
        'child_ids', to_jsonb(coalesce(v_child_ids, '{}'::uuid[]))
      );
    when 'leave_custom_drive' then
      -- leave_custom_drive returns void — use PERFORM.
      perform public.leave_custom_drive(v_trip_id, v_child_id);
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'custom_drive_left',
        'trip_id', v_trip_id,
        'child_id', v_child_id
      );
    when 'cancel_custom_drive' then
      -- cancel_custom_drive returns jsonb — safe to assign. Its result IS
      -- the cancelled_drive body snapshot the push branch expects (the
      -- trip rows are deleted by execution).
      v_exec_result := public.cancel_custom_drive(v_trip_id);
      v_notifications := v_notifications || jsonb_build_object(
        'type', 'custom_drive_cancelled',
        'cancelled_drive', v_exec_result
      );
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

  -- ── Execution fan-out (2026-09-30 parity fix) ──────────────────
  -- Parked swaps returned above; admin_sql/coordinator kinds collected
  -- nothing. Only a first real execution notifies (executed_at belt).
  if v_proposal.executed_at is null
    and v_notifications is not null
    and jsonb_array_length(v_notifications) > 0 then

    insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
    values (
      v_proposal.group_id,
      null,
      'proposal_fanout',
      'chat_proposal',
      p_proposal_id::text,
      jsonb_build_object('kind', v_proposal.kind, 'notifications', v_notifications)
    );

    select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'cron_secret'
    limit 1;

    select decrypted_secret into v_base_url
    from vault.decrypted_secrets
    where name = 'cron_edge_base_url'
    limit 1;

    -- Fail-soft: no vault secrets (local dev, fresh reset) → skip silently.
    if v_secret is not null and v_base_url is not null then
      for v_note in select value as note_body from jsonb_array_elements(v_notifications) loop
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
          raise notice 'proposal fan-out post failed: %', sqlerrm;
        end;
      end loop;
    else
      raise notice 'proposal fan-out skipped: missing vault secrets';
    end if;
  end if;

  return v_proposal;
end;
$$;

revoke all on function public.execute_chat_proposal(uuid) from public, authenticated;

commit;