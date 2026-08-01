-- Tighten privacy within a carpool group:
-- 1. Profiles: restrict select to self-only (was self OR shares_group_with_profile).
--    Add list_group_profiles RPC for group-scoped reads (excludes email).
-- 2. Driver confirmations: restrict select to the driver, coordinator, or
--    affected parents (was any group member).

-- 1a. Function to list profiles in a group (excludes email)
drop function if exists public.list_group_profiles(uuid);
create or replace function public.list_group_profiles(target_group_id uuid)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  default_drive_preferences jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.avatar_url, p.default_drive_preferences, p.created_at, p.updated_at
  from public.profiles p
  join public.memberships m on m.profile_id = p.id
  where m.group_id = target_group_id
    and m.status = 'active';
$$;

revoke all on function public.list_group_profiles(uuid) from public;
grant execute on function public.list_group_profiles(uuid) to authenticated;

-- 1b. Tighten profiles select to self-only
drop policy "profiles_select_group" on public.profiles;
create policy "profiles_select_self"
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- 2. Tighten driver_confirmations select to driver, coordinator, or affected parent
drop policy "confirmations_select_group" on public.driver_confirmations;
create policy "confirmations_select_scoped"
  on public.driver_confirmations for select to authenticated
  using (
    exists(
      select 1 from public.driver_assignments da
      where da.id = driver_confirmations.driver_assignment_id
        and (
          da.driver_profile_id = auth.uid()
          or public.is_group_coordinator(da.group_id)
          or exists(
            select 1 from public.rider_assignments ra
            join public.children c on c.id = ra.child_id
            join public.memberships m on m.household_id = c.household_id
            where ra.driver_assignment_id = da.id
              and m.profile_id = auth.uid()
              and m.status = 'active'
          )
        )
    )
  );