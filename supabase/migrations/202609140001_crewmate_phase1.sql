-- Crewmate AI — Phase 1 (Q&A-only).
-- Spec: CREWMATE_REQUIREMENTS.md (repo root) §5, §10, §13.
--
-- Ships DISABLED: groups.crewmate_enabled defaults to false, and the
-- notify_chat_agent trigger is gated on it, so nothing runs for a group
-- until a coordinator flips the flag on.
--
-- Phase 1 hard boundary: the chat-agent function answers schedule
-- questions only. Its write surface is chat_messages (sender_kind='agent')
-- plus this ledger — never chat_proposals and never a schedule table
-- (contract-tested in tests/crewmate.test.mjs). The one place Phase 1
-- executes SQL is the SELECT-only crewmate_readonly_query RPC, which is
-- enforced at the database level by grants, RLS, and a keyword allowlist.

-- ── 1. Group flag + monthly token budget ──────────────────────

alter table public.groups
  add column if not exists crewmate_enabled boolean not null default false;

alter table public.groups
  add column if not exists crewmate_monthly_token_budget integer not null default 2000000;

-- ── 2. Private Crewmate threads (kind = 'agent') ───────────────
-- One per parent per group; the sole human participant is the creator.
-- RLS needs no new policies: can_read_chat_thread already grants the
-- participant, and coordinators see it while groups.coordinator_chat_access
-- is on (near-term oversight).

alter table public.chat_threads drop constraint if exists chat_threads_kind_check;
alter table public.chat_threads
  add constraint chat_threads_kind_check
    check (kind in ('dm', 'group', 'everyone', 'agent'));

alter table public.chat_threads drop constraint if exists chat_threads_check;
alter table public.chat_threads
  add constraint chat_threads_check check (
    (kind = 'dm' and dm_a_id is not null and dm_b_id is not null
      and dm_a_id < dm_b_id and title is null)
    or (kind = 'group' and dm_a_id is null and dm_b_id is null
      and char_length(coalesce(title, '')) > 0)
    or (kind = 'everyone' and dm_a_id is null and dm_b_id is null and title is null)
    or (kind = 'agent' and dm_a_id is null and dm_b_id is null and title is null)
  );

-- One agent thread per parent per group
create unique index if not exists chat_threads_agent_unique
  on public.chat_threads (group_id, created_by)
  where kind = 'agent';

-- ── RPC: ensure_agent_thread ──────────────────────────────────
-- Idempotently create (or return) the caller's private Crewmate thread.
-- Posts the standard Crewmate disclosure note on first creation —
-- do not remove the disclosure.
create or replace function public.ensure_agent_thread(target_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_group_member(target_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  insert into public.chat_threads (group_id, kind, created_by)
  values (target_group_id, 'agent', auth.uid())
  on conflict do nothing
  returning id into v_thread_id;

  if v_thread_id is not null then
    insert into public.chat_participants (thread_id, profile_id)
    values (v_thread_id, auth.uid())
    on conflict do nothing;

    insert into public.chat_messages (thread_id, sender_kind, sender_name, body)
    values (
      v_thread_id,
      'system',
      'Carpool Crew',
      'This is your private conversation with Crewmate AI, the carpool assistant. Ask it anything about the schedule — it only proposes changes, and nothing changes unless a parent confirms.'
    );
  else
    select id into v_thread_id
    from public.chat_threads
    where group_id = target_group_id
      and kind = 'agent'
      and created_by = auth.uid();

    if v_thread_id is null then
      raise exception 'Crewmate thread missing and could not be created';
    end if;
  end if;

  -- Idempotently enroll the caller (insert-only preserves last_read_at)
  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread_id, auth.uid())
  on conflict do nothing;

  return v_thread_id;
end;
$$;

revoke all on function public.ensure_agent_thread(uuid) from public;
grant execute on function public.ensure_agent_thread(uuid) to authenticated;

-- ── 3. crewmate_runs ledger ────────────────────────────────────
-- One row per agent invocation: feeds the monthly budget guard and the
-- catalog gap log (Phase 2). Coordinator-readable (Phase 4 builds the UI).

create table public.crewmate_runs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  trigger_message_id uuid references public.chat_messages(id) on delete set null,
  status text not null
    check (status in (
      'running', 'coalesced', 'skipped_budget', 'chatter',
      'answered', 'action_deferred', 'failed'
    )),
  coalesced_count integer not null default 0,
  triage_model text,
  planner_model text,
  triage_tokens_in integer not null default 0,
  triage_tokens_out integer not null default 0,
  planner_tokens_in integer not null default 0,
  planner_tokens_out integer not null default 0,
  tool_calls jsonb not null default '[]'::jsonb,
  outcome_detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, group_id)
);

create index crewmate_runs_group_month_idx
  on public.crewmate_runs (group_id, started_at);
create index crewmate_runs_thread_idx
  on public.crewmate_runs (thread_id, started_at);

-- Coalescing lock: at most one 'running' row per thread. Stale rows are
-- reaped by claim_crewmate_run so a crashed invocation never wedges this.
create unique index crewmate_runs_one_running_per_thread
  on public.crewmate_runs (thread_id)
  where status = 'running';

alter table public.crewmate_runs enable row level security;

create policy crewmate_runs_select_coordinator
  on public.crewmate_runs for select to authenticated
  using (public.is_group_coordinator(group_id));

grant select on public.crewmate_runs to authenticated;

-- ── RPC: claim_crewmate_run ────────────────────────────────────
-- Per-thread run coalescing. Returns the new run id, or NULL when a live
-- run already owns the thread (the caller exits; the live run re-checks
-- for newer messages before it posts). Service-role only.

create or replace function public.claim_crewmate_run(
  p_group_id uuid,
  p_thread_id uuid,
  p_trigger_message_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed';
  end if;

  -- Reap stale runs (crashed invocations) so the one-running-per-thread
  -- partial unique index never wedges.
  update public.crewmate_runs
  set status = 'failed',
      finished_at = now(),
      outcome_detail = outcome_detail || jsonb_build_object('error', 'stale_run_reaped')
  where status = 'running'
    and started_at < now() - interval '90 seconds';

  insert into public.crewmate_runs (group_id, thread_id, trigger_message_id, status)
  values (p_group_id, p_thread_id, p_trigger_message_id, 'running')
  on conflict do nothing
  returning id into v_run_id;

  if v_run_id is null then
    -- A live run owns this thread; it will see this newer message when it
    -- re-checks before posting its answer.
    update public.crewmate_runs
    set coalesced_count = coalesced_count + 1
    where thread_id = p_thread_id
      and status = 'running'
      and started_at > now() - interval '90 seconds';
    return null;
  end if;

  return v_run_id;
end;
$$;

revoke all on function public.claim_crewmate_run(uuid, uuid, uuid) from public, authenticated;
grant execute on function public.claim_crewmate_run(uuid, uuid, uuid) to service_role;

-- ── 4. crewmate_readonly role + RLS ───────────────────────────
-- The SELECT-only SQL tool executes as this role under RLS, scoped to one
-- group via the transaction-local app.crewmate_group GUC. With no policy
-- rows visible for any other role, and no grants on profiles (emails,
-- phones), auth.users, vault, or the chat tables, a malicious or malformed
-- statement can only ever read the asking group's own schedule rows.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crewmate_readonly') then
    create role crewmate_readonly nologin;
  end if;
end
$$;

-- Security-definer functions owned by postgres SET ROLE to this role.
grant crewmate_readonly to postgres;

grant usage on schema public to crewmate_readonly;

grant select on public.groups, public.memberships, public.households,
  public.vehicles, public.weeks, public.trips, public.weekly_checkins,
  public.ride_requests, public.driver_availability, public.driver_assignments,
  public.rider_assignments, public.schedule_versions, public.driver_confirmations,
  public.audit_events
  to crewmate_readonly;

-- children: column-limited grant. kid phone numbers are drive-scoped
-- (visible only to the assigned driver on the Drive Detail screen) and
-- photos are a directory nicety — neither belongs in an agent answer.
grant select (id, group_id, household_id, first_name, last_name, active,
  is_priority, preferred_buddy_child_id)
  on public.children to crewmate_readonly;

-- Unset GUC → current_setting returns NULL → no rows. Safe default.
create policy crewmate_readonly_groups
  on public.groups for select to crewmate_readonly
  using (id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_memberships
  on public.memberships for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_households
  on public.households for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_children
  on public.children for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_vehicles
  on public.vehicles for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_weeks
  on public.weeks for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_trips
  on public.trips for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_weekly_checkins
  on public.weekly_checkins for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_ride_requests
  on public.ride_requests for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_driver_availability
  on public.driver_availability for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_driver_assignments
  on public.driver_assignments for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_rider_assignments
  on public.rider_assignments for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_schedule_versions
  on public.schedule_versions for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_driver_confirmations
  on public.driver_confirmations for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

create policy crewmate_readonly_audit_events
  on public.audit_events for select to crewmate_readonly
  using (group_id = current_setting('app.crewmate_group', true)::uuid);

-- ── RPC: crewmate_readonly_query ─────────────────────────────
-- The flexible read tool. Runs one SELECT (or WITH) as crewmate_readonly
-- under RLS scoped to p_group_id, with a statement timeout and a 500-row
-- cap. Statement shape is validated here — Postgres is the enforcement
-- point, not the edge function. Service-role only.
--
-- SECURITY INVOKER, deliberately: Postgres forbids SET ROLE inside
-- security-definer functions ("cannot set parameter role within
-- security-definer function"). The only caller is service_role (execute
-- grant + the auth.role() gate below); the first thing the body does is
-- drop its own privileges via `set local role crewmate_readonly`, after
-- which every statement runs under that role's grants and RLS policies.

grant crewmate_readonly to service_role;

create or replace function public.crewmate_readonly_query(
  p_group_id uuid,
  p_sql text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_sql text;
  v_wrapped text;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed';
  end if;

  if p_group_id is null then
    raise exception 'Group required';
  end if;

  -- Strip ALL surrounding whitespace (btrim only handles spaces, and a
  -- leading tab/newline would defeat the starts-with-select check), then a
  -- single trailing semicolon.
  v_sql := regexp_replace(coalesce(p_sql, ''), '^\s+|\s+$', '', 'g');
  v_sql := regexp_replace(v_sql, ';\s*$', '');
  v_sql := regexp_replace(v_sql, '^\s+|\s+$', '', 'g');

  if char_length(v_sql) = 0 or char_length(v_sql) > 4000 then
    raise exception 'Query must be between 1 and 4000 characters';
  end if;

  -- Single statement only: no comments, no semicolons, starts with
  -- select/with, and no mutation/utility/dangerous keywords anywhere.
  if position(';' in v_sql) > 0 then
    raise exception 'Only a single SELECT statement is allowed';
  end if;

  if v_sql like '%--%' or v_sql like '%/*%' then
    raise exception 'Comments are not allowed';
  end if;

  if v_sql !~* '^(select|with)\y' then
    raise exception 'Only SELECT statements are allowed';
  end if;

  if v_sql ~* '\y(insert|update|delete|merge|alter|drop|truncate|create|grant|revoke|copy|comment|do|into|call|listen|notify|set_config|setval|reset|advisory|lock|share|vacuum|analyze|reindex|cluster|prepare|execute|deallocate|fetch|move|close|current_setting|import|security|sudo)\y' then
    raise exception 'Forbidden keyword in query';
  end if;

  -- Any word starting with pg_ or lo_ (pg_read_file, pg_ls_dir, lo_import,
  -- dblink-style helpers): system internals have no place in schedule
  -- answers. Role privileges already deny these; the keyword gate makes the
  -- rejection fast and legible to the planner.
  if v_sql ~* '\mpg_' or v_sql ~* '\mlo_' or v_sql ~* '\mdblink' then
    raise exception 'Forbidden keyword in query';
  end if;

  execute 'set local statement_timeout = 5000';
  execute 'set local role crewmate_readonly';
  perform set_config('app.crewmate_group', p_group_id::text, true);

  v_wrapped := 'select coalesce(jsonb_agg(t), ''[]''::jsonb) '
    || 'from (select * from (' || v_sql || ') crewmate_sub limit 500) t';

  begin
    execute v_wrapped into v_result;
  exception when others then
    -- Surface the database error to the planner so it can rephrase the
    -- query (permission denials on un-granted tables/columns land here).
    return jsonb_build_object('error', sqlerrm);
  end;

  return jsonb_build_object(
    'rows', v_result,
    'row_count', jsonb_array_length(coalesce(v_result, '[]'::jsonb))
  );
end;
$$;

revoke all on function public.crewmate_readonly_query(uuid, text) from public, authenticated;
grant execute on function public.crewmate_readonly_query(uuid, text) to service_role;

-- ── 5. Invoke trigger: parent messages → chat-agent ────────────
-- Mirrors notify_chat_message_push (fail-soft vault pattern). Flag-gated:
-- a disabled group generates no invocations and no cost. Agent/system
-- messages never invoke the agent (no self-triggering loops).

create or replace function public.notify_chat_agent()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_enabled boolean;
begin
  if new.sender_kind <> 'parent' then
    return new;
  end if;

  select g.crewmate_enabled into v_enabled
  from public.chat_threads t
  join public.groups g on g.id = t.group_id
  where t.id = new.thread_id;

  if not coalesce(v_enabled, false) then
    return new;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return new;
  end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets
  where name = 'cron_edge_base_url'
  limit 1;

  if v_base_url is null then
    raise notice 'No cron_edge_base_url found in vault';
    return new;
  end if;

  perform net.http_post(
    url := v_base_url || '/chat-agent',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'thread_id', new.thread_id,
      'message_id', new.id
    ),
    timeout_milliseconds := 120000
  );

  return new;
end;
$$;

revoke all on function public.notify_chat_agent() from public, authenticated;

create trigger chat_messages_notify_agent
after insert on public.chat_messages
for each row execute function public.notify_chat_agent();