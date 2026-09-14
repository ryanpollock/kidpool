-- Crewmate AI: @Crewmate mentions.
-- Parents expect to tag the assistant with @ like any other participant.
-- Crewmate has no profile row (by design — M1), so its mention form is
-- {profile_id: null, label: '@Crewmate', start, end}. The validation
-- trigger learns exactly that one extra shape; every null-profile mention
-- with any other label still rejects. Consumers are null-safe by
-- construction: chatRecipients' mentioned-set never matches a null,
-- push titles compare profile ids, and the in-app <mark> rendering keys
-- on spans. Semantics: an @Crewmate tag is an explicit invocation — the
-- chat-agent function treats it like a private-thread message (always
-- responds, no triage silence, no NOREPLY gate).

create or replace function public.validate_chat_mentions() returns trigger language plpgsql security definer set search_path = public as $$
declare item jsonb; normalized jsonb := '[]'::jsonb; previous_end integer := 0; start_pos integer; end_pos integer;
begin
  if jsonb_typeof(new.mentions) <> 'array' or jsonb_array_length(new.mentions) > 30 then raise exception 'Invalid mentions'; end if;
  for item in select value from jsonb_array_elements(new.mentions) loop
    start_pos := (item->>'start')::integer; end_pos := (item->>'end')::integer;
    if start_pos is null or end_pos is null or start_pos < previous_end or end_pos <= start_pos or end_pos > char_length(new.body)
      or not (
        exists (
          select 1 from public.chat_participants cp
          join public.chat_threads t on t.id=cp.thread_id
          join public.memberships m on m.profile_id=cp.profile_id and m.group_id=t.group_id and m.status='active'
          join public.profiles p on p.id=cp.profile_id
          where cp.thread_id=new.thread_id and cp.profile_id=(item->>'profile_id')::uuid
            and item->>'label' = '@' || p.full_name
            and substring(new.body from start_pos+1 for end_pos-start_pos)=item->>'label'
        )
        or (
          -- The one sanctioned non-parent mention: the Crewmate AI tag.
          (item->>'profile_id') is null
          and item->>'label' = '@Crewmate'
          and substring(new.body from start_pos+1 for end_pos-start_pos)='@Crewmate'
        )
      ) then raise exception 'Invalid mention or recipient'; end if;
    normalized := normalized || jsonb_build_array(jsonb_build_object(
      'profile_id', (item->>'profile_id')::uuid, 'label', item->>'label', 'start', start_pos, 'end', end_pos));
    previous_end := end_pos;
  end loop;
  new.mentions := normalized;
  return new;
end $$;
revoke all on function public.validate_chat_mentions() from public;