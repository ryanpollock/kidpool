-- Parent directory: security-definer RPC returning phone + email for
-- all active members of a group. Phone/email are returned only when the
-- owner has share_phone/share_email = true (opt-out by default).
-- Joins to households for household_name and memberships for role.

create or replace function public.list_group_directory(target_group_id uuid)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  phone text,
  share_phone boolean,
  share_email boolean,
  household_id uuid,
  household_name text,
  role text
)
language sql security definer set search_path = public as $$
  select p.id,
         p.full_name,
         p.avatar_url,
         case when p.share_email then p.email else null end,
         case when p.share_phone then p.phone else null end,
         p.share_phone,
         p.share_email,
         m.household_id,
         h.name,
         m.role::text
  from public.profiles p
  join public.memberships m on m.profile_id = p.id
  join public.households h on h.id = m.household_id
  where m.group_id = target_group_id
    and m.status = 'active';
$$;

revoke all on function public.list_group_directory(uuid) from public;
grant execute on function public.list_group_directory(uuid) to authenticated;