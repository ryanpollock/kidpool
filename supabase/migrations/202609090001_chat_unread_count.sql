-- App icon badge: per-parent total unread across all chat threads.
--
-- Called by send-push's chat_message branch so the service worker can set
-- the iOS home-screen app icon badge from the push payload while the app
-- is closed (the Badging API is what iOS shows on installed web apps);
-- the SPA also syncs the badge on every unread refresh while the app runs.
--
-- Mirrors the in-app badge definition exactly (list_chat_threads +
-- refreshChatUnread): messages newer than the participant's read cursor,
-- muted threads excluded, active membership required — removed members
-- lose both conversation access and any badge count from it.

create or replace function public.count_unread_chat(target_profile_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.chat_participants cp
  join public.chat_threads t
    on t.id = cp.thread_id
  join public.memberships m
    on m.group_id = t.group_id
   and m.profile_id = target_profile_id
   and m.status = 'active'
  join public.chat_messages msg
    on msg.thread_id = cp.thread_id
   and msg.created_at > cp.last_read_at
  where cp.profile_id = target_profile_id
    and cp.notifications_muted = false;
$$;

revoke all on function public.count_unread_chat(uuid) from public;
grant execute on function public.count_unread_chat(uuid) to authenticated;