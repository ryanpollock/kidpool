-- Chat foundation: parent-to-parent messaging (1:1 DMs, custom group
-- threads, one all-parents "everyone" thread) with an in-thread proposal
-- model for the Crew AI coordinator agent (Milestone 2).
--
-- Design (see BACKEND_ARCHITECTURE.md §18 / AGENTS.md):
--   - Threads are group-scoped. kind = 'dm' | 'group' | 'everyone'.
--   - DM pairs are canonicalized (dm_a_id < dm_b_id) with one thread per
--     pair per group (partial unique index).
--   - One 'everyone' thread per group (partial unique index). Every active
--     member is enrolled: at migration time via backfill, on join via the
--     membership trigger, and idempotently via ensure_everyone_thread.
--   - Sender name/avatar are DENORMALIZED onto each message at insert
--     time. Removed members' profiles stop being readable, but their
--     historical messages keep rendering.
--   - Crew AI is not a profile (no auth.users row): agent/system messages
--     have sender_profile_id NULL and a fixed sender_name.
--   - Coordinator oversight (near-term product decision): coordinators can
--     read and post in ALL group threads while groups.coordinator_chat_access
--     is true. Flipping that column to false removes the human admin from
--     threads they are not a participant of — the end-state once Crew AI
--     has earned trust.
--   - chat_proposals: Crew AI proposes schedule changes as structured rows
--     rendered as cards in the thread. The LLM never mutates the schedule
--     directly — confirm_chat_proposal executes the existing invariant-
--     enforcing RPCs (cancel_ride_for_child, switch_child_afternoon_trip)
--     transactionally with the confirming parent as auth.uid(). In this
--     milestone nothing creates proposals yet (the agent lands in M2);
--     the table, confirm/decline RPCs, and UI rendering ship now.
--   - Push notifications: AFTER INSERT trigger on parent messages POSTs
--     to send-push via pg_net (same fail-soft vault pattern as the
--     no_rides_requested trigger). The edge function enumerates thread
--     participants, skips the sender and muted/non-active members, and
--     deep-links to /#thread=<id>. No email for chat messages.
--   - Realtime: chat_messages + chat_proposals join the supabase_realtime
--     publication with REPLICA IDENTITY FULL so RLS policies are enforced
--     on postgres_changes events (a non-participant must never receive
--     another thread's messages).

-- ── groups: coordinator oversight flag ───────────────────────
alter table public.groups
  add column if not exists coordinator_chat_access boolean not null default true;

-- ── Tables ───────────────────────────────────────────────────

create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  kind text not null check (kind in ('dm', 'group', 'everyone')),
  title text check (title is null or char_length(trim(title)) between 1 and 80),
  dm_a_id uuid references public.profiles(id) on delete cascade,
  dm_b_id uuid references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, group_id),
  check (
    (kind = 'dm' and dm_a_id is not null and dm_b_id is not null
      and dm_a_id < dm_b_id and title is null)
    or (kind = 'group' and dm_a_id is null and dm_b_id is null
      and char_length(coalesce(title, '')) > 0)
    or (kind = 'everyone' and dm_a_id is null and dm_b_id is null and title is null)
  )
);

-- One DM thread per parent pair per group
create unique index chat_threads_dm_pair_unique
  on public.chat_threads (group_id, dm_a_id, dm_b_id)
  where kind = 'dm';

-- One everyone-thread per group
create unique index chat_threads_everyone_unique
  on public.chat_threads (group_id)
  where kind = 'everyone';

create index chat_threads_inbox_idx
  on public.chat_threads (group_id, last_message_at desc);

create table public.chat_participants (
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  notifications_muted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (thread_id, profile_id)
);

create index chat_participants_profile_idx
  on public.chat_participants (profile_id);

-- Crew AI proposals: structured schedule changes posted into a thread.
-- kind: cancel_ride {child_id, driver_assignment_id}
--       switch_slot {child_id, driver_assignment_id}
--       swap_drive  {assignment_id, target_profile_id}     (M2)
--       coverage_fill {trip_id, schedule_version_id}      (M2)
-- required_confirmer_profile_id NULL = any thread participant may confirm
-- (coverage calls). Status flips are RPC-only.
create table public.chat_proposals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  triggered_by_message_id uuid,
  kind text not null check (kind in ('cancel_ride', 'switch_slot', 'swap_drive', 'coverage_fill')),
  params jsonb not null default '{}'::jsonb,
  summary text not null check (char_length(trim(summary)) between 1 and 500),
  required_confirmer_profile_id uuid references public.profiles(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'executed', 'declined', 'expired', 'failed')),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  executed_at timestamptz,
  executed_result jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, group_id)
);

create index chat_proposals_thread_idx
  on public.chat_proposals (thread_id, status);

create trigger chat_proposals_set_updated_at
before update on public.chat_proposals
for each row execute function public.set_updated_at();

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender_profile_id uuid references public.profiles(id) on delete set null,
  sender_kind text not null default 'parent' check (sender_kind in ('parent', 'agent', 'system')),
  sender_name text not null default '',
  sender_avatar_url text,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  proposal_id uuid references public.chat_proposals(id) on delete set null,
  created_at timestamptz not null default now()
);

create index chat_messages_thread_idx
  on public.chat_messages (thread_id, created_at desc);

-- ── Thread-visibility helper ─────────────────────────────────
-- Shared by every chat RLS policy and the inbox RPC: a thread is readable
-- when the caller is an active participant, OR when the caller is an
-- active coordinator and the group's oversight flag is on. Security
-- definer (like is_group_member) so policies don't recurse.

create or replace function public.can_read_chat_thread(target_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_threads t
    where t.id = target_thread_id
      and (
        (
          public.is_group_member(t.group_id)
          and exists (
            select 1 from public.chat_participants cp
            where cp.thread_id = t.id
              and cp.profile_id = auth.uid()
          )
        )
        or (
          public.is_group_coordinator(t.group_id)
          and exists (
            select 1 from public.groups g
            where g.id = t.group_id
              and g.coordinator_chat_access
          )
        )
      )
  );
$$;

revoke all on function public.can_read_chat_thread(uuid) from public;
grant execute on function public.can_read_chat_thread(uuid) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────

alter table public.chat_threads enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_proposals enable row level security;

-- Threads: readable per helper; no direct write policies (RPCs only)
create policy chat_threads_select_readable
  on public.chat_threads for select to authenticated
  using (public.can_read_chat_thread(id));

-- Participants: visible for readable threads (thread rosters); each
-- member may update only their own row (last_read_at, notifications_muted)
create policy chat_participants_select_readable
  on public.chat_participants for select to authenticated
  using (
    profile_id = auth.uid()
    or public.can_read_chat_thread(thread_id)
  );
create policy chat_participants_update_self
  on public.chat_participants for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Messages: readable per thread visibility. Parents may insert only
-- their own parent-kind messages into threads they participate in
-- (coordinators may post in any group thread while oversight is on).
-- Messages are immutable — no update or delete policies.
create policy chat_messages_select_readable
  on public.chat_messages for select to authenticated
  using (public.can_read_chat_thread(thread_id));
create policy chat_messages_insert_participant
  on public.chat_messages for insert to authenticated
  with check (
    sender_kind = 'parent'
    and sender_profile_id = auth.uid()
    and exists (
      select 1 from public.chat_threads t
      where t.id = chat_messages.thread_id
        and (
          (
            public.is_group_member(t.group_id)
            and exists (
              select 1 from public.chat_participants cp
              where cp.thread_id = t.id
                and cp.profile_id = auth.uid()
            )
          )
          or (
            public.is_group_coordinator(t.group_id)
            and exists (
              select 1 from public.groups g
              where g.id = t.group_id
                and g.coordinator_chat_access
            )
          )
        )
    )
  );

-- Proposals: readable per thread visibility (cards render inline);
-- all writes go through confirm/decline RPCs (and the M2 agent's
-- service-role inserts)
create policy chat_proposals_select_readable
  on public.chat_proposals for select to authenticated
  using (public.can_read_chat_thread(thread_id));

-- ── Message triggers ─────────────────────────────────────────

-- BEFORE INSERT: denormalize sender identity from profiles for parent
-- messages; require an explicit name for agent/system messages.
create or replace function public.fill_chat_message_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_avatar_url text;
begin
  if new.sender_kind = 'parent' then
    if new.sender_profile_id is null then
      raise exception 'Parent messages require a sender profile';
    end if;

    select full_name, avatar_url
    into v_name, v_avatar_url
    from public.profiles
    where id = new.sender_profile_id;

    if v_name is null then
      raise exception 'Sender profile not found';
    end if;

    new.sender_name := v_name;
    new.sender_avatar_url := v_avatar_url;
  elsif char_length(trim(new.sender_name)) = 0 then
    raise exception 'Agent and system messages require a sender name';
  end if;

  return new;
end;
$$;

revoke all on function public.fill_chat_message_sender() from public, authenticated;

create trigger chat_messages_fill_sender
before insert on public.chat_messages
for each row execute function public.fill_chat_message_sender();

-- AFTER INSERT: keep thread.last_message_at fresh for inbox sorting
create or replace function public.touch_chat_thread_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_threads
  set last_message_at = greatest(last_message_at, new.created_at)
  where id = new.thread_id;
  return new;
end;
$$;

revoke all on function public.touch_chat_thread_last_message() from public, authenticated;

create trigger chat_messages_touch_thread
after insert on public.chat_messages
for each row execute function public.touch_chat_thread_last_message();

-- AFTER INSERT: push-notify parent messages via the send-push edge
-- function (pg_net). Fail-soft: if the vault secrets are missing (local
-- dev stack) the message insert still succeeds. Mirrors the
-- no_rides_requested trigger pattern (202608150001).
create or replace function public.notify_chat_message_push()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
begin
  if new.sender_kind <> 'parent' then
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
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'chat_message',
      'thread_id', new.thread_id,
      'message_id', new.id,
      'sender_profile_id', new.sender_profile_id,
      'sender_name', new.sender_name,
      'body', left(new.body, 300)
    ),
    timeout_milliseconds := 120000
  );

  return new;
end;
$$;

revoke all on function public.notify_chat_message_push() from public, authenticated;

create trigger chat_messages_notify_push
after insert on public.chat_messages
for each row execute function public.notify_chat_message_push();

-- ── Everyone-thread enrollment ──────────────────────────────
-- New active members are auto-enrolled into their group's everyone
-- thread so inbox listing and push fan-out never miss them.
create or replace function public.enroll_member_in_everyone_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' then
    insert into public.chat_participants (thread_id, profile_id)
    select t.id, new.profile_id
    from public.chat_threads t
    where t.group_id = new.group_id
      and t.kind = 'everyone'
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.enroll_member_in_everyone_thread() from public, authenticated;

create trigger memberships_enroll_everyone_thread
after insert on public.memberships
for each row execute function public.enroll_member_in_everyone_thread();

-- ── RPC: ensure_everyone_thread ─────────────────────────────
-- Idempotently create the group's everyone thread (enrolling all active
-- members) and enroll the caller. Called by the client when the Chat tab
-- opens. Returns the thread id.
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
      'This is the group conversation for all parents. Crew AI, the carpool assistant, will be in every chat to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
    );
  end if;

  return v_thread_id;
end;
$$;

revoke all on function public.ensure_everyone_thread(uuid) from public;
grant execute on function public.ensure_everyone_thread(uuid) to authenticated;

-- ── RPC: create_dm_thread ────────────────────────────────────
-- Open (or create) the 1:1 thread with another active member of the
-- caller's group. Idempotent via the canonical (dm_a, dm_b) pair index.
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
      'Crew AI, the carpool assistant, will be in this conversation to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
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

-- ── RPC: create_group_thread ─────────────────────────────────
-- Create a group thread with a caller-chosen subset of active group
-- members (2–20 parents plus the creator). Title is required (the check
-- constraint enforces it for kind='group').
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
    'Group conversation started. Crew AI, the carpool assistant, will be in this conversation to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
  );

  return v_thread_id;
end;
$$;

revoke all on function public.create_group_thread(uuid[], text) from public;
grant execute on function public.create_group_thread(uuid[], text) to authenticated;

-- ── RPC: mark_thread_read ────────────────────────────────────
-- Update the caller's read cursor. For coordinators visiting a thread
-- they are not (yet) a participant of, this lazily creates their row.
create or replace function public.mark_thread_read(target_thread_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.can_read_chat_thread(target_thread_id) then
    raise exception 'You do not have access to this conversation';
  end if;

  insert into public.chat_participants (thread_id, profile_id, last_read_at)
  values (target_thread_id, auth.uid(), now())
  on conflict (thread_id, profile_id) do update
    set last_read_at = now();
end;
$$;

revoke all on function public.mark_thread_read(uuid) from public;
grant execute on function public.mark_thread_read(uuid) to authenticated;

-- ── RPC: set_thread_notifications_muted ──────────────────────
create or replace function public.set_thread_notifications_muted(
  target_thread_id uuid,
  p_muted boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.can_read_chat_thread(target_thread_id) then
    raise exception 'You do not have access to this conversation';
  end if;

  insert into public.chat_participants (thread_id, profile_id, notifications_muted)
  values (target_thread_id, auth.uid(), p_muted)
  on conflict (thread_id, profile_id) do update
    set notifications_muted = p_muted;
end;
$$;

revoke all on function public.set_thread_notifications_muted(uuid, boolean) from public;
grant execute on function public.set_thread_notifications_muted(uuid, boolean) to authenticated;

-- ── RPC: list_chat_threads ────────────────────────────────────
-- Inbox listing for the caller: every thread they participate in, plus
-- every group thread while coordinator oversight is on. One row per
-- thread with the last message, unread count, mute state, and a
-- participants roster (id/name/avatar) for header rendering.
create or replace function public.list_chat_threads()
returns table (
  thread_id uuid,
  group_id uuid,
  kind text,
  title text,
  dm_a_id uuid,
  dm_b_id uuid,
  created_at timestamptz,
  last_message_at timestamptz,
  last_message_body text,
  last_message_sender_name text,
  last_message_sender_kind text,
  last_message_created_at timestamptz,
  unread_count bigint,
  last_read_at timestamptz,
  notifications_muted boolean,
  participants jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select t.id as visible_thread_id
    from public.chat_threads t
    where (
      public.is_group_member(t.group_id)
      and exists (
        select 1 from public.chat_participants cp
        where cp.thread_id = t.id
          and cp.profile_id = auth.uid()
      )
    )
    or (
      public.is_group_coordinator(t.group_id)
      and exists (
        select 1 from public.groups g
        where g.id = t.group_id
          and g.coordinator_chat_access
      )
    )
  ),
  me as (
    select cp.thread_id as me_thread_id,
           cp.last_read_at as me_last_read_at,
           cp.notifications_muted as me_muted
    from public.chat_participants cp
    where cp.profile_id = auth.uid()
  )
  select
    t.id as thread_id,
    t.group_id,
    t.kind,
    t.title,
    t.dm_a_id,
    t.dm_b_id,
    t.created_at,
    t.last_message_at,
    lm.body as last_message_body,
    lm.sender_name as last_message_sender_name,
    lm.sender_kind as last_message_sender_kind,
    lm.created_at as last_message_created_at,
    (
      select count(*) from public.chat_messages m
      where m.thread_id = t.id
        and m.created_at > coalesce(me.me_last_read_at, '-infinity'::timestamptz)
    ) as unread_count,
    me.me_last_read_at as last_read_at,
    coalesce(me.me_muted, false) as notifications_muted,
    (
      select coalesce(jsonb_agg(q.member order by q.member ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', cp2.profile_id,
          'name', p.full_name,
          'avatar_url', p.avatar_url
        ) as member
        from public.chat_participants cp2
        join public.profiles p on p.id = cp2.profile_id
        where cp2.thread_id = t.id
      ) q
    ) as participants
  from public.chat_threads t
  join visible v on v.visible_thread_id = t.id
  left join me on me.me_thread_id = t.id
  left join lateral (
    select m.body, m.sender_name, m.sender_kind, m.created_at
    from public.chat_messages m
    where m.thread_id = t.id
    order by m.created_at desc
    limit 1
  ) lm on true
  order by t.last_message_at desc;
$$;

revoke all on function public.list_chat_threads() from public;
grant execute on function public.list_chat_threads() to authenticated;

-- ── RPC: confirm_chat_proposal ────────────────────────────────
-- A parent confirms a pending Crew AI proposal; the schedule mutation
-- executes transactionally through the existing invariant-enforcing
-- RPCs (which re-validate ownership/freshness against the confirming
-- parent's JWT). swap_drive and coverage_fill execution land with the
-- M2 agent; confirming them here is rejected.
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
    'Crew AI',
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

-- ── RPC: decline_chat_proposal ────────────────────────────────
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
    'Crew AI',
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

-- ── Realtime ──────────────────────────────────────────────────
-- REPLICA IDENTITY FULL is required for Supabase Realtime to enforce
-- RLS on postgres_changes events: a parent must not receive message
-- events for threads they cannot read. chat_threads is published for
-- the inbox: every message bumps last_message_at, so one UPDATE event
-- per message refreshes the inbox listing.
alter publication supabase_realtime add table public.chat_threads;
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.chat_proposals;

alter table public.chat_threads replica identity full;
alter table public.chat_messages replica identity full;
alter table public.chat_proposals replica identity full;

-- ── Backfill: everyone threads for existing groups ───────────
do $$
declare
  g record;
  v_thread_id uuid;
begin
  for g in select id from public.groups loop
    insert into public.chat_threads (group_id, kind)
    values (g.id, 'everyone')
    on conflict do nothing
    returning id into v_thread_id;

    if v_thread_id is not null then
      insert into public.chat_participants (thread_id, profile_id)
      select v_thread_id, m.profile_id
      from public.memberships m
      where m.group_id = g.id
        and m.status = 'active'
      on conflict do nothing;

      insert into public.chat_messages (thread_id, sender_kind, sender_name, body)
      values (
        v_thread_id,
        'system',
        'Carpool Crew',
        'This is the group conversation for all parents. Crew AI, the carpool assistant, will be in every chat to help coordinate rides — it only proposes changes, and nothing changes unless a parent confirms.'
      );
    end if;
  end loop;
end $$;

-- ── Grants ────────────────────────────────────────────────────

grant select on public.chat_threads to authenticated;
grant select, update on public.chat_participants to authenticated;
grant select, insert on public.chat_messages to authenticated;
grant select on public.chat_proposals to authenticated;