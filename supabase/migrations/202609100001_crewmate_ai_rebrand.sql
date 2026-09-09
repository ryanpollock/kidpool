-- Rename the assistant from "Crew AI" to "Crewmate AI".
--
-- "Crew" is an existing well-known AI company; the assistant's name changes
-- everywhere the system generates it. The foundation migration
-- (202609070001) now writes "Crewmate AI" directly, so on fresh installs the
-- function re-creations below are identical no-ops — this migration exists
-- to update databases that applied the foundation BEFORE the rename
-- (staging, production), where the message-writing functions still embed
-- the old name.
--
-- Two parts:
--   1. Re-create the five message-writing functions with the new name
--      (identical to the foundation definitions).
--   2. Update existing system/agent message rows so disclosure notes and
--      agent names parents can already see reflect the rename. Parent
--      messages are never touched.

create or replace function public.ensure_everyone_thread(target_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_created boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_group_member(target_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  insert into public.chat_threads (group_id, kind, created_by)
  values (target_group_id, 'everyone', auth.uid())
  on conflict do nothing
  returning id into v_thread_id;

  if v_thread_id is not null then
    v_created := true;

    insert into public.chat_participants (thread_id, profile_id)
    select v_thread_id, m.profile_id
    from public.memberships m
    where m.group_id = target_group_id
      and m.status = 'active'
    on conflict do nothing;
  else
    select id into v_thread_id
    from public.chat_threads
    where group_id = target_group_id
      and kind = 'everyone';

    if v_thread_id is null then
      raise exception 'Everyone thread missing and could not be created';
    end if;
  end if;

  -- Idempotently enroll the caller (insert-only: an existing row's
  -- last_read_at must be preserved so unread state survives re-opening)
  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread_id, auth.uid())
  on conflict do nothing;

  if v_created then
    insert into public.chat_messages (thread_id, sender_kind, sender_name, body)
    values (
      v_thread_id,
      'system',
      'Carpool Crew',
      'This is the group conversation for all parents. Crewmate AI, the carpool assistant, will be in every chat to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
    );
  end if;

  return v_thread_id;
end;
$$;

revoke all on function public.ensure_everyone_thread(uuid) from public;
grant execute on function public.ensure_everyone_thread(uuid) to authenticated;

create or replace function public.create_dm_thread(target_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_a uuid;
  v_b uuid;
  v_thread_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if target_profile_id = auth.uid() then
    raise exception 'Cannot start a conversation with yourself';
  end if;

  select m.group_id into v_group_id
  from public.memberships m
  where m.profile_id = auth.uid()
    and m.status = 'active'
  limit 1;

  if v_group_id is null then
    raise exception 'You are not an active member of a group';
  end if;

  perform 1 from public.memberships m
  where m.group_id = v_group_id
    and m.profile_id = target_profile_id
    and m.status = 'active';

  if not found then
    raise exception 'That parent is not an active member of your group';
  end if;

  v_a := least(auth.uid(), target_profile_id);
  v_b := greatest(auth.uid(), target_profile_id);

  insert into public.chat_threads (group_id, kind, dm_a_id, dm_b_id, created_by)
  values (v_group_id, 'dm', v_a, v_b, auth.uid())
  on conflict do nothing
  returning id into v_thread_id;

  if v_thread_id is not null then
    insert into public.chat_participants (thread_id, profile_id)
    values (v_thread_id, v_a), (v_thread_id, v_b)
    on conflict do nothing;

    insert into public.chat_messages (thread_id, sender_kind, sender_name, body)
    values (
      v_thread_id,
      'system',
      'Carpool Crew',
      'Crewmate AI, the carpool assistant, will be in this conversation to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
    );
  else
    select id into v_thread_id
    from public.chat_threads
    where group_id = v_group_id
      and kind = 'dm'
      and dm_a_id = v_a
      and dm_b_id = v_b;
  end if;

  return v_thread_id;
end;
$$;

revoke all on function public.create_dm_thread(uuid) from public;
grant execute on function public.create_dm_thread(uuid) to authenticated;

create or replace function public.create_group_thread(
  target_profile_ids uuid[],
  thread_title text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_thread_id uuid;
  v_member_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if target_profile_ids is null or array_length(target_profile_ids, 1) is null then
    raise exception 'Select at least one parent for the group';
  end if;

  if array_length(target_profile_ids, 1) > 20 then
    raise exception 'Group conversations are capped at 20 parents';
  end if;

  if nullif(trim(thread_title), '') is null then
    raise exception 'Group conversations need a name';
  end if;

  select m.group_id into v_group_id
  from public.memberships m
  where m.profile_id = auth.uid()
    and m.status = 'active'
  limit 1;

  if v_group_id is null then
    raise exception 'You are not an active member of a group';
  end if;

  if exists (select 1 from unnest(target_profile_ids) x where x = auth.uid()) then
    raise exception 'Do not include yourself in the selection';
  end if;

  select count(distinct m.profile_id) into v_member_count
  from public.memberships m
  where m.group_id = v_group_id
    and m.status = 'active'
    and m.profile_id = any(target_profile_ids);

  if v_member_count <> (select count(distinct x) from unnest(target_profile_ids) x) then
    raise exception 'All selected parents must be active members of your group';
  end if;

  insert into public.chat_threads (group_id, kind, title, created_by)
  values (v_group_id, 'group', nullif(trim(thread_title), ''), auth.uid())
  returning id into v_thread_id;

  insert into public.chat_participants (thread_id, profile_id)
  select v_thread_id, p from unnest(target_profile_ids) p
  on conflict do nothing;

  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread_id, auth.uid())
  on conflict do nothing;

  insert into public.chat_messages (thread_id, sender_kind, sender_name, body)
  values (
    v_thread_id,
    'system',
    'Carpool Crew',
    'Group conversation started. Crewmate AI, the carpool assistant, will be in this conversation to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
  );

  return v_thread_id;
end;
$$;

revoke all on function public.create_group_thread(uuid[], text) from public;
grant execute on function public.create_group_thread(uuid[], text) to authenticated;

create or replace function public.confirm_chat_proposal(p_proposal_id uuid)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal public.chat_proposals;
  v_child_id uuid;
  v_driver_assignment_id uuid;
  v_switch_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_proposal
  from public.chat_proposals
  where id = p_proposal_id
  for update;

  if v_proposal.id is null then
    raise exception 'Proposal not found';
  end if;

  if v_proposal.status <> 'pending' then
    raise exception 'This proposal is no longer pending (status: %)', v_proposal.status;
  end if;

  if v_proposal.expires_at <= now() then
    raise exception 'This proposal has expired';
  end if;

  if v_proposal.required_confirmer_profile_id is not null
    and v_proposal.required_confirmer_profile_id <> auth.uid() then
    raise exception 'Only the requested parent can confirm this proposal';
  end if;

  if not public.can_read_chat_thread(v_proposal.thread_id) then
    raise exception 'You do not have access to this conversation';
  end if;

  update public.chat_proposals
  set status = 'confirmed'
  where id = p_proposal_id;

  v_child_id := v_proposal.params ->> 'child_id';
  v_driver_assignment_id := v_proposal.params ->> 'driver_assignment_id';

  case v_proposal.kind
    when 'cancel_ride' then
      if v_child_id is null or v_driver_assignment_id is null then
        raise exception 'Proposal is missing child or assignment parameters';
      end if;
      perform public.cancel_ride_for_child(v_child_id, v_driver_assignment_id);
    when 'switch_slot' then
      if v_child_id is null or v_driver_assignment_id is null then
        raise exception 'Proposal is missing child or assignment parameters';
      end if;
      v_switch_result := public.switch_child_afternoon_trip(v_child_id, v_driver_assignment_id);
    else
      raise exception 'Proposal kind % is not supported yet', v_proposal.kind;
  end case;

  update public.chat_proposals
  set status = 'executed',
      executed_at = now(),
      executed_result = coalesce(
        v_switch_result,
        jsonb_build_object('kind', v_proposal.kind)
      )
  where id = p_proposal_id
  returning * into v_proposal;

  insert into public.chat_messages (
    thread_id, sender_kind, sender_name, body, proposal_id
  )
  values (
    v_proposal.thread_id,
    'agent',
    'Crewmate AI',
    'Done — ' || v_proposal.summary,
    v_proposal.id
  );

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_proposal.group_id,
    auth.uid(),
    'chat_proposal_confirmed',
    'chat_proposal',
    v_proposal.id::text,
    jsonb_build_object(
      'kind', v_proposal.kind,
      'params', v_proposal.params,
      'summary', v_proposal.summary
    )
  );

  return v_proposal;
end;
$$;

revoke all on function public.confirm_chat_proposal(uuid) from public;
grant execute on function public.confirm_chat_proposal(uuid) to authenticated;

create or replace function public.decline_chat_proposal(p_proposal_id uuid)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal public.chat_proposals;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_proposal
  from public.chat_proposals
  where id = p_proposal_id
  for update;

  if v_proposal.id is null then
    raise exception 'Proposal not found';
  end if;

  if v_proposal.status <> 'pending' then
    raise exception 'This proposal is no longer pending (status: %)', v_proposal.status;
  end if;

  if v_proposal.required_confirmer_profile_id is not null
    and v_proposal.required_confirmer_profile_id <> auth.uid() then
    raise exception 'Only the requested parent can decline this proposal';
  end if;

  if not public.can_read_chat_thread(v_proposal.thread_id) then
    raise exception 'You do not have access to this conversation';
  end if;

  update public.chat_proposals
  set status = 'declined'
  where id = p_proposal_id
  returning * into v_proposal;

  insert into public.chat_messages (
    thread_id, sender_kind, sender_name, body, proposal_id
  )
  values (
    v_proposal.thread_id,
    'agent',
    'Crewmate AI',
    'Okay — ' || v_proposal.summary || ' is off the table. Nothing changed.',
    v_proposal.id
  );

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    v_proposal.group_id,
    auth.uid(),
    'chat_proposal_declined',
    'chat_proposal',
    v_proposal.id::text,
    jsonb_build_object('kind', v_proposal.kind)
  );

  return v_proposal;
end;
$$;

revoke all on function public.decline_chat_proposal(uuid) from public;
grant execute on function public.decline_chat_proposal(uuid) to authenticated;

-- ── Existing message rows ──────────────────────────────────────
-- System disclosure notes and agent messages only; parent messages are
-- user content and are never rewritten.

update public.chat_messages
set body = replace(body, 'Crew AI', 'Crewmate AI')
where sender_kind in ('system', 'agent')
  and body like '%Crew AI%';

update public.chat_messages
set sender_name = 'Crewmate AI'
where sender_kind = 'agent'
  and sender_name = 'Crew AI';
