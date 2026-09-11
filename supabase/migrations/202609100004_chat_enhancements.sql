begin;

-- Chat enhancements. Additive schema; legacy mute clients remain supported.
alter table public.chat_messages add column mentions jsonb not null default '[]'::jsonb;
alter table public.chat_participants add column notification_mode text not null default 'all'
  check (notification_mode in ('all','mentions','muted'));
update public.chat_participants set notification_mode = case when notifications_muted then 'muted' else 'all' end;

create function public.sync_chat_notification_mode() returns trigger language plpgsql set search_path=public as $$
begin
  if TG_OP = 'INSERT' then
    if new.notifications_muted then new.notification_mode := 'muted'; end if;
  elsif new.notification_mode is not distinct from old.notification_mode and new.notifications_muted is distinct from old.notifications_muted then
    new.notification_mode := case when new.notifications_muted then 'muted' else 'all' end;
  end if;
  new.notifications_muted := new.notification_mode = 'muted';
  return new;
end $$;
create trigger chat_participants_sync_mode before insert or update on public.chat_participants
for each row execute function public.sync_chat_notification_mode();

-- Offsets are Unicode code points (not UTF-16 code units), zero-based, end-exclusive.
-- Validation runs for direct REST inserts too, before the push trigger can fire.
create function public.validate_chat_mentions() returns trigger language plpgsql security definer set search_path=public as $$
declare item jsonb; normalized jsonb := '[]'::jsonb; previous_end integer := 0; start_pos integer; end_pos integer;
begin
  if jsonb_typeof(new.mentions) <> 'array' or jsonb_array_length(new.mentions) > 30 then raise exception 'Invalid mentions'; end if;
  for item in select value from jsonb_array_elements(new.mentions) loop
    start_pos := (item->>'start')::integer; end_pos := (item->>'end')::integer;
    if start_pos is null or end_pos is null or start_pos < previous_end or end_pos <= start_pos or end_pos > char_length(new.body)
      or not exists (
        select 1 from public.chat_participants cp
        join public.chat_threads t on t.id=cp.thread_id
        join public.memberships m on m.profile_id=cp.profile_id and m.group_id=t.group_id and m.status='active'
        join public.profiles p on p.id=cp.profile_id
        where cp.thread_id=new.thread_id and cp.profile_id=(item->>'profile_id')::uuid
          and item->>'label' = '@' || p.full_name
          and substring(new.body from start_pos+1 for end_pos-start_pos)=item->>'label'
      ) then raise exception 'Invalid mention or recipient'; end if;
    normalized := normalized || jsonb_build_array(jsonb_build_object(
      'profile_id', (item->>'profile_id')::uuid, 'label', item->>'label', 'start', start_pos, 'end', end_pos));
    previous_end := end_pos;
  end loop;
  new.mentions := normalized;
  return new;
end $$;
revoke all on function public.validate_chat_mentions() from public;
create trigger chat_messages_validate_mentions before insert on public.chat_messages for each row execute function public.validate_chat_mentions();

create function public.set_thread_notification_mode(target_thread_id uuid, p_mode text) returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.can_read_chat_thread(target_thread_id) then raise exception 'Conversation access required'; end if;
 if p_mode not in ('all','mentions','muted') or p_mode is null then raise exception 'Invalid notification mode'; end if;
 if p_mode='mentions' and not exists(select 1 from public.chat_threads where id=target_thread_id and kind='everyone') then raise exception 'Mentions only is available in Everyone'; end if;
 insert into public.chat_participants(thread_id,profile_id,notification_mode,notifications_muted)
 values(target_thread_id,auth.uid(),p_mode,p_mode='muted')
 on conflict(thread_id,profile_id) do update set notification_mode=excluded.notification_mode, notifications_muted=excluded.notifications_muted;
end $$;
revoke all on function public.set_thread_notification_mode(uuid,text) from public;
grant execute on function public.set_thread_notification_mode(uuid,text) to authenticated;

create table public.chat_reactions (
 message_id uuid not null references public.chat_messages(id) on delete cascade,
 thread_id uuid not null references public.chat_threads(id) on delete cascade,
 profile_id uuid not null references public.profiles(id) on delete cascade,
 emoji text check(emoji in ('👍','❤️','😂','😮','😢','🙏')),
 primary key(message_id,profile_id)
);
create index chat_reactions_thread_idx on public.chat_reactions(thread_id);
alter table public.chat_reactions enable row level security;
create policy chat_reactions_read on public.chat_reactions for select to authenticated using(public.can_read_chat_thread(thread_id));
-- Soft removal (emoji=null) gives filtered, RLS-protected realtime UPDATE events.
create function public.set_chat_reaction(p_message_id uuid,p_emoji text) returns void
language plpgsql security definer set search_path=public as $$
declare thread uuid;
begin
 select thread_id into thread from public.chat_messages where id=p_message_id and sender_kind='parent';
 if auth.uid() is null or thread is null or not public.can_read_chat_thread(thread) then raise exception 'Message access required'; end if;
 insert into public.chat_reactions(message_id,thread_id,profile_id,emoji) values(p_message_id,thread,auth.uid(),p_emoji)
 on conflict(message_id,profile_id) do update set emoji=excluded.emoji;
end $$;
revoke all on function public.set_chat_reaction(uuid,text) from public;
grant execute on function public.set_chat_reaction(uuid,text) to authenticated;
alter table public.chat_reactions replica identity full;
alter publication supabase_realtime add table public.chat_reactions;

create table public.chat_link_previews (
 message_id uuid primary key references public.chat_messages(id) on delete cascade,
 thread_id uuid not null references public.chat_threads(id) on delete cascade,
 url text not null,
 status text not null default 'pending' check(status in ('pending','ready','failed')),
 title text, description text, image_data text,
 updated_at timestamptz not null default now()
);
alter table public.chat_link_previews enable row level security;
create policy chat_link_previews_read on public.chat_link_previews for select to authenticated using(public.can_read_chat_thread(thread_id));
alter table public.chat_link_previews replica identity full;
alter publication supabase_realtime add table public.chat_link_previews;

create function public.list_chat_extras(p_message_ids uuid[]) returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object(
 'reactions',coalesce((select jsonb_agg(jsonb_build_object('message_id',r.message_id,'profile_id',r.profile_id,'emoji',r.emoji,'name',p.full_name))
 from public.chat_reactions r join public.profiles p on p.id=r.profile_id
 where r.message_id=any(p_message_ids) and r.emoji is not null and public.can_read_chat_thread(r.thread_id)), '[]'::jsonb),
 'previews',coalesce((select jsonb_agg(to_jsonb(lp)) from public.chat_link_previews lp
 where lp.message_id=any(p_message_ids) and public.can_read_chat_thread(lp.thread_id)), '[]'::jsonb))
 where cardinality(p_message_ids)<=120;
$$;
revoke all on function public.list_chat_extras(uuid[]) from public;
grant execute on function public.list_chat_extras(uuid[]) to authenticated;

create or replace function public.list_chat_threads_v2()
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
  participants jsonb,
  notification_mode text,
  attention_count bigint
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
           cp.notifications_muted as me_muted, cp.notification_mode as me_mode
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
        where cp2.thread_id = t.id and exists(select 1 from public.memberships am where am.profile_id=cp2.profile_id and am.group_id=t.group_id and am.status='active')
      ) q
    ) as participants,
    coalesce(me.me_mode,'all') as notification_mode,
    (select count(*) from public.chat_messages m where m.thread_id=t.id
      and m.created_at > coalesce(me.me_last_read_at, '-infinity'::timestamptz)
      and m.sender_profile_id is distinct from auth.uid()
      and coalesce(me.me_mode,'all') <> 'muted'
      and (coalesce(me.me_mode,'all')='all' or exists(select 1 from jsonb_array_elements(m.mentions) x where x->>'profile_id'=auth.uid()::text))) as attention_count
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

revoke all on function public.list_chat_threads_v2() from public;
grant execute on function public.list_chat_threads_v2() to authenticated;

create or replace function public.count_unread_chat(target_profile_id uuid) returns integer
language sql stable security definer set search_path=public as $$
 select count(*)::integer from public.chat_participants cp
 join public.chat_threads t on t.id=cp.thread_id
 join public.memberships mem on mem.group_id=t.group_id and mem.profile_id=target_profile_id and mem.status='active'
 join public.chat_messages msg on msg.thread_id=cp.thread_id and msg.created_at>cp.last_read_at
 where cp.profile_id=target_profile_id and cp.notification_mode<>'muted'
 and msg.sender_profile_id is distinct from target_profile_id
 and (auth.uid()=target_profile_id or auth.role()='service_role')
 and (cp.notification_mode='all' or exists(select 1 from jsonb_array_elements(msg.mentions) x where x->>'profile_id'=target_profile_id::text));
$$;

-- Explicit grants: this project's default privileges do not grant table DML.
grant select on public.chat_reactions, public.chat_link_previews to authenticated;
grant all on public.chat_reactions, public.chat_link_previews to service_role;
grant execute on function public.count_unread_chat(uuid) to service_role;

commit;
