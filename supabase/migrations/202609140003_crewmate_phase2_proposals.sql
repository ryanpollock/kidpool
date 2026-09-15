-- Crewmate AI — Phase 2: proposal confirmation, dual consent, in-thread
-- consent, and the coordinator admin_sql tier.
-- Spec: CREWMATE_REQUIREMENTS.md §6–§8, §13 (Phase 2), §14 (rejected
-- mechanisms — no runtime DDL, parent-facing SQL, ever).

-- ── 1. Coordinator admin tier (admin_sql) ─────────────────────────
-- Confinement by ownership, not SET ROLE (Postgres forbids SET ROLE
-- inside security-definer frames; the Phase 1 readonly RPC uses the
-- invoker pattern, but the admin executor must remain callable from
-- confirm_chat_proposal's definer frame — a definer function OWNED BY a
-- low-privilege role runs as that role regardless of who calls it).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crewmate_admin') then
    create role crewmate_admin nologin;
  end if;
end
$$;

-- Operational tables only. Never: groups, chat tables, audit_events (as a
-- target), profiles, or anything in auth/vault.
grant usage on schema public to crewmate_admin;
grant select, insert, update, delete on public.children, public.vehicles,
  public.households, public.memberships, public.weeks, public.trips,
  public.weekly_checkins, public.ride_requests, public.driver_availability,
  public.driver_assignments, public.rider_assignments, public.schedule_versions,
  public.driver_confirmations
  to crewmate_admin;

-- Audit trail: the executor writes its own audit row (scoped by the GUC).
grant insert (group_id, actor_profile_id, action, entity_type, entity_id, details, occurred_at)
  on public.audit_events to crewmate_admin;
grant select on public.audit_events to crewmate_admin;

-- Proposal updates: the admin executor marks its own proposal executed.
-- Scoped by RLS to the group the transaction is pinned to.
grant update (status, executed_at, executed_result, failure_reason, updated_at)
  on public.chat_proposals to crewmate_admin;
grant select on public.chat_proposals to crewmate_admin;

-- Group scoping via the transaction-local GUC — every read, write, and
-- moved row stays inside the coordinator's group (with-check blocks
-- re-pointing rows at another group).
create policy crewmate_admin_children_select on public.children for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_children_insert on public.children for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_children_update on public.children for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_children_delete on public.children for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_vehicles_select on public.vehicles for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_vehicles_insert on public.vehicles for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_vehicles_update on public.vehicles for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_vehicles_delete on public.vehicles for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_households_select on public.households for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_households_insert on public.households for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_households_update on public.households for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_households_delete on public.households for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_memberships_select on public.memberships for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_memberships_insert on public.memberships for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_memberships_update on public.memberships for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_memberships_delete on public.memberships for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_weeks_select on public.weeks for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_weeks_update on public.weeks for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_trips_select on public.trips for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_trips_update on public.trips for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_weekly_checkins_select on public.weekly_checkins for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_weekly_checkins_update on public.weekly_checkins for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_ride_requests_select on public.ride_requests for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_ride_requests_insert on public.ride_requests for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_ride_requests_update on public.ride_requests for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_ride_requests_delete on public.ride_requests for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_driver_availability_select on public.driver_availability for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_driver_availability_insert on public.driver_availability for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_driver_availability_delete on public.driver_availability for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_driver_assignments_select on public.driver_assignments for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_driver_assignments_update on public.driver_assignments for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_rider_assignments_select on public.rider_assignments for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_rider_assignments_insert on public.rider_assignments for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_rider_assignments_update on public.rider_assignments for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_rider_assignments_delete on public.rider_assignments for delete to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_schedule_versions_select on public.schedule_versions for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_admin_driver_confirmations_select on public.driver_confirmations for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

-- chat_proposals: the executor marks its own row executed. No insert.
create policy crewmate_admin_proposals_select on public.chat_proposals for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_proposals_update on public.chat_proposals for update to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid)
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);

-- audit_events: insert-only, group-scoped.
create policy crewmate_admin_audit_insert on public.audit_events for insert to crewmate_admin
  with check (group_id = current_setting('app.crewmate_group', true)::uuid);
create policy crewmate_admin_audit_select on public.audit_events for select to crewmate_admin
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

-- ── RPC: crewmate_admin_sql_execute ──────────────────────────────
-- Runs the coordinator-confirmed DML confined to crewmate_admin's grants
-- and the group GUC. Single statement, allowlisted table, no DDL ever.
-- SECURITY DEFINER + OWNER crewmate_admin = the confinement itself.

-- NOTE: auth.uid() is unreachable here — postgres does not own the auth
-- schema, so USAGE cannot be granted to crewmate_admin (a silent no-op
-- grant). The caller (execute_chat_proposal, definer postgres) captures
-- auth.uid() from the JWT and passes it as p_actor_id; the coordinator
-- re-validation below uses that, against the GUC-scoped memberships rows.
create or replace function public.crewmate_admin_sql_execute(
  p_proposal_id uuid,
  p_group_id uuid,
  p_actor_id uuid,
  p_sql text,
  p_preview jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := p_actor_id;
  v_sql text;
  v_wrapped text;
  v_table text;
  v_schema text;
  v_rows jsonb;
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  -- Pin the group FIRST: the coordinator validation reads memberships
  -- rows scoped by this GUC (the only table access before the DML itself).
  perform set_config('app.crewmate_group', p_group_id::text, true);

  -- Re-validate the HUMAN facts: the actor is an active coordinator of the
  -- group being touched. (Inlined — the auth.uid()-based helper is
  -- unreachable in this confined frame.)
  if not exists (
    select 1 from public.memberships m
    where m.group_id = p_group_id
      and m.profile_id = v_actor
      and m.role = 'coordinator'
      and m.status = 'active'
  ) then
    raise exception 'Only coordinators can execute admin SQL';
  end if;

  v_sql := regexp_replace(coalesce(p_sql, ''), '^\s+|\s+$', '', 'g');
  v_sql := regexp_replace(v_sql, ';\s*$', '');
  v_sql := regexp_replace(v_sql, '^\s+|\s+$', '', 'g');

  if char_length(v_sql) = 0 or char_length(v_sql) > 4000 then
    raise exception 'Statement must be between 1 and 4000 characters';
  end if;

  if position(';' in v_sql) > 0 then
    raise exception 'Only a single statement is allowed';
  end if;

  if v_sql like '%--%' or v_sql like '%/*%' then
    raise exception 'Comments are not allowed';
  end if;

  -- DML only: insert into / update / delete from.
  if v_sql !~* '^(insert\s+into|update|delete\s+from)\y' then
    raise exception 'Only INSERT, UPDATE, or DELETE statements are allowed';
  end if;

  -- No schema changes, no grants, no dangerous helpers, ever.
  if v_sql ~* '\y(insert\s+into|update|delete\s+from)\y[\s\S]*\y(alter|drop|truncate|create|grant|revoke|copy|comment|do|call|set_config|setval|reset|advisory|lock|vacuum|analyze|reindex|cluster|prepare|execute|deallocate|current_setting|import|security|sudo)\y' then
    raise exception 'Forbidden keyword in statement';
  end if;
  if v_sql ~* '\mpg_' or v_sql ~* '\mlo_' or v_sql ~* '\mdblink' then
    raise exception 'Forbidden keyword in statement';
  end if;

  -- Target table must be on the operational allowlist.
  v_table := lower((regexp_match(v_sql, '^(?:insert\s+into|update|delete\s+from)\s+([\w".]+)'))[1]);
  if v_table is null then
    raise exception 'Could not read the target table';
  end if;
  v_table := btrim(v_table, '"');
  if v_table like '%.%' then
    v_schema := split_part(v_table, '.', 1);
    v_table := split_part(v_table, '.', 2);
  else
    v_schema := 'public';
  end if;
  if v_schema <> 'public' then
    raise exception 'Only public schema tables are allowed';
  end if;

  if v_table not in (
    'children', 'vehicles', 'households', 'memberships', 'weeks', 'trips',
    'weekly_checkins', 'ride_requests', 'driver_availability',
    'driver_assignments', 'rider_assignments', 'schedule_versions',
    'driver_confirmations'
  ) then
    raise exception 'Table % is not on the admin allowlist', v_table;
  end if;

  execute 'set local statement_timeout = 5000';

  -- RETURNING capture so the audit shows exactly which rows changed.
  if v_sql ~* '\yreturning\y' then
    v_wrapped := 'with __crewmate_r as (' || v_sql || ') '
      || 'select coalesce(jsonb_agg(__crewmate_r), ''[]''::jsonb) from __crewmate_r limit 501';
  else
    v_wrapped := 'with __crewmate_r as (' || v_sql || ' returning *) '
      || 'select coalesce(jsonb_agg(__crewmate_r), ''[]''::jsonb) from __crewmate_r limit 501';
  end if;

  begin
    execute v_wrapped into v_rows;
    get diagnostics v_count = row_count;
  exception when others then
    update public.chat_proposals
    set status = 'failed',
        failure_reason = sqlerrm
    where id = p_proposal_id;
    return jsonb_build_object('error', sqlerrm);
  end;

  update public.chat_proposals
  set status = 'executed',
      executed_at = now(),
      executed_result = jsonb_build_object(
        'sql', v_sql,
        'row_count', v_count,
        'rows', coalesce(v_rows, '[]'::jsonb),
        'before_preview', p_preview
      )
  where id = p_proposal_id;

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (
    p_group_id,
    v_actor,
    'crewmate_admin_sql_executed',
    'chat_proposal',
    p_proposal_id::text,
    jsonb_build_object(
      'sql', v_sql,
      'row_count', v_count,
      'rows', coalesce(v_rows, '[]'::jsonb),
      'before_preview', p_preview
    )
  );

  return jsonb_build_object('row_count', v_count, 'rows', coalesce(v_rows, '[]'::jsonb));
end;
$$;

-- Confinement: the function runs as crewmate_admin (its grants + RLS are
-- the blast radius), while auth.uid() still reads the coordinator's JWT.
-- Internal-only: the sole caller is confirm_chat_proposal's definer frame
-- (postgres) plus service-role eval/tests. Never executable by clients.
-- Order matters: privileges are set while postgres still owns the
-- function; ownership transfer preserves them.
revoke all on function public.crewmate_admin_sql_execute(uuid, uuid, uuid, text, jsonb) from public, authenticated;
grant execute on function public.crewmate_admin_sql_execute(uuid, uuid, uuid, text, jsonb) to postgres, service_role;
grant crewmate_admin to postgres; -- ownership transfer requires membership
-- ALTER OWNER requires the new owner to have CREATE on the function's
-- schema; granted only for the transfer and revoked right after.
grant create on schema public to crewmate_admin;
alter function public.crewmate_admin_sql_execute(uuid, uuid, uuid, text, jsonb) owner to crewmate_admin;
revoke create on schema public from crewmate_admin;

-- ── 2. Shared execution: every proposal kind → its executor ──────
-- Called AFTER consent validation by both confirm_chat_proposal (button)
-- and confirm_chat_proposal_via_consent (detected in-thread "yes").

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
      -- Dual consent: a swap executes only when BOTH linked proposals are
      -- confirmed. First confirmation parks; the second executes both.
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

      -- Both linked proposals complete together: the sibling by this
      -- branch, this one here (so the outer status accounting sees
      -- 'executed' and skips its own update).
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
      v_exec_result := public.offer_custom_drive(
        v_proposal.group_id,
        (v_proposal.params ->> 'service_date')::date,
        (v_proposal.params ->> 'direction')::public.trip_direction,
        (v_proposal.params ->> 'meeting_time')::time,
        coalesce((v_proposal.params ->> 'child_ids')::uuid[], '{}'::uuid[])
      );
    when 'join_custom_drive' then
      v_exec_result := public.join_custom_drive(
        v_trip_id,
        coalesce((v_proposal.params ->> 'child_ids')::uuid[], '{}'::uuid[])
      );
    when 'leave_custom_drive' then
      perform public.leave_custom_drive(v_trip_id, v_child_id);
    when 'cancel_custom_drive' then
      v_exec_result := public.cancel_custom_drive(v_trip_id);
    when 'admin_sql' then
      -- The executor re-validates the coordinator, runs the confined DML,
      -- and marks the proposal executed with before/after audit.
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

-- ── 3. confirm_chat_proposal (button path, all Phase 2 kinds) ────

create or replace function public.confirm_chat_proposal(p_proposal_id uuid)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal public.chat_proposals;
  v_executed public.chat_proposals;
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

  v_executed := public.execute_chat_proposal(p_proposal_id);

  -- Status accounting:
  --   admin_sql      — the executor marked itself executed.
  --   swap_drive     — parked (waiting on the other driver) stays
  --                    'confirmed'; the sibling-executed path already set
  --                    'executed' on this row from the other confirm.
  --   everything else — executed now.
  declare
    v_status text;
  begin
    select status into v_status from public.chat_proposals where id = p_proposal_id;
    if v_status = 'confirmed' and v_executed.kind not in ('admin_sql', 'swap_drive') then
      update public.chat_proposals
      set status = 'executed',
          executed_at = now(),
          executed_result = jsonb_build_object('kind', v_executed.kind)
      where id = p_proposal_id;
    end if;
  end;

  select * into v_proposal from public.chat_proposals where id = p_proposal_id;

  insert into public.chat_messages (thread_id, sender_kind, sender_name, body, proposal_id)
  values (
    v_proposal.thread_id,
    'agent',
    'Crewmate AI',
    case
      when v_proposal.status = 'confirmed' and v_proposal.kind = 'swap_drive'
        then 'Got your OK — waiting on the other driver before the swap happens. Nothing has changed yet.'
      when v_proposal.status = 'executed'
        then 'Done — ' || v_proposal.summary
      else 'Done — ' || v_proposal.summary
    end,
    v_proposal.id
  );

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (
    v_proposal.group_id,
    auth.uid(),
    'chat_proposal_confirmed',
    'chat_proposal',
    v_proposal.id::text,
    jsonb_build_object(
      'kind', v_proposal.kind,
      'params', v_proposal.params,
      'summary', v_proposal.summary,
      'via', 'button'
    )
  );

  return v_proposal;
end;
$$;

revoke all on function public.confirm_chat_proposal(uuid) from public;
grant execute on function public.confirm_chat_proposal(uuid) to authenticated;

-- ── 4. In-thread consent ("yes" detection, server-validated) ─────
-- Service-only (the agent calls this after classifying an affirmative
-- reply from the required confirmer). Every fact is re-checked here:
-- the evidence message must exist, be a parent message in the proposal's
-- thread, come from the required confirmer, and be recent. The executor
-- chain then runs with the CONFIRMER's identity via the transaction-
-- local JWT claims, so every executor's own auth.uid() gates apply
-- unchanged.

create or replace function public.confirm_chat_proposal_via_consent(
  p_proposal_id uuid,
  p_evidence_message_id uuid
)
returns public.chat_proposals
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal public.chat_proposals;
  v_evidence record;
  v_executed public.chat_proposals;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed';
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

  if v_proposal.required_confirmer_profile_id is null then
    raise exception 'This proposal has no required confirmer';
  end if;

  select id, thread_id, sender_profile_id, sender_kind, created_at
  into v_evidence
  from public.chat_messages
  where id = p_evidence_message_id;

  if v_evidence.id is null
    or v_evidence.thread_id <> v_proposal.thread_id
    or v_evidence.sender_kind <> 'parent'
    or v_evidence.sender_profile_id <> v_proposal.required_confirmer_profile_id then
    raise exception 'Consent evidence does not match the required confirmer';
  end if;

  if v_evidence.created_at < now() - interval '24 hours' then
    raise exception 'Consent evidence is stale';
  end if;

  -- Run the execution chain as the confirmer: executors read auth.uid()
  -- from the JWT claims, pinned to this transaction.
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_proposal.required_confirmer_profile_id, 'role', 'authenticated')::text,
    true
  );

  update public.chat_proposals
  set status = 'confirmed'
  where id = p_proposal_id;

  v_executed := public.execute_chat_proposal(p_proposal_id);

  declare
    v_status text;
  begin
    select status into v_status from public.chat_proposals where id = p_proposal_id;
    if v_status = 'confirmed' and v_executed.kind not in ('admin_sql', 'swap_drive') then
      update public.chat_proposals
      set status = 'executed',
          executed_at = now(),
          executed_result = jsonb_build_object('kind', v_executed.kind)
      where id = p_proposal_id;
    end if;
  end;

  select * into v_proposal from public.chat_proposals where id = p_proposal_id;

  insert into public.chat_messages (thread_id, sender_kind, sender_name, body, proposal_id)
  values (
    v_proposal.thread_id,
    'agent',
    'Crewmate AI',
    case
      when v_proposal.status = 'confirmed' and v_proposal.kind = 'swap_drive'
        then 'Got your OK — waiting on the other driver before the swap happens. Nothing has changed yet.'
      else 'Done — ' || v_proposal.summary
    end,
    v_proposal.id
  );

  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (
    v_proposal.group_id,
    v_proposal.required_confirmer_profile_id,
    'chat_proposal_confirmed',
    'chat_proposal',
    v_proposal.id::text,
    jsonb_build_object(
      'kind', v_proposal.kind,
      'summary', v_proposal.summary,
      'via', 'in_thread_consent',
      'evidence_message_id', p_evidence_message_id
    )
  );

  return v_proposal;
end;
$$;

revoke all on function public.confirm_chat_proposal_via_consent(uuid, uuid) from public, authenticated;
grant execute on function public.confirm_chat_proposal_via_consent(uuid, uuid) to service_role;