-- Group threads: auto-generate the title from participant names when the
-- caller doesn't provide one. The database CHECK still requires a non-empty
-- title for kind='group' — the RPC fills it before insert, so the data
-- model is unchanged. Parents see the participant names in the inbox
-- (same as DMs), which is more useful than a required made-up name.

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
  v_auto_title text;
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

  -- Auto-title from participant first names when the caller doesn't provide
  -- one. The DB CHECK for kind='group' still requires non-empty title —
  -- this fills it, so the constraint never fires.
  if nullif(trim(coalesce(thread_title, '')), '') is null then
    select string_agg(split_part(p.full_name, ' ', 1), ', ' order by p.full_name)
    into v_auto_title
    from public.profiles p
    where p.id = any(target_profile_ids);

    if v_auto_title is null or char_length(trim(v_auto_title)) = 0 then
      v_auto_title := 'Group conversation';
    end if;

    thread_title := v_auto_title;
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