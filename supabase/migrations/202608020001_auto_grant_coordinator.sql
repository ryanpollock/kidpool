-- Auto-grant coordinator role to the first household creator in a group.
-- Previously, create_household_with_membership inserted the creator as 'member'
-- (the column default), making all admin actions permanently unreachable.

create or replace function public.create_household_with_membership(
  target_group_id uuid,
  household_name text
)
returns table (household_id uuid, join_code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  created_household_id uuid;
  raw_join_code text;
  assigned_role public.app_role;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Profile is not ready';
  end if;

  if not exists (select 1 from public.groups where id = target_group_id) then
    raise exception 'Carpool group not found';
  end if;

  if exists (
    select 1 from public.memberships
    where group_id = target_group_id
      and profile_id = auth.uid()
      and status <> 'removed'
  ) then
    raise exception 'This account already belongs to a household';
  end if;

  insert into public.households (group_id, name, created_by)
  values (target_group_id, trim(household_name), auth.uid())
  returning id into created_household_id;

  -- Grant coordinator to the first household creator in the group,
  -- so there is always at least one admin. Subsequent creators get member.
  if not exists (
    select 1 from public.memberships
    where group_id = target_group_id
      and role = 'coordinator'
      and status = 'active'
  ) then
    assigned_role := 'coordinator';
  else
    assigned_role := 'member';
  end if;

  insert into public.memberships (group_id, household_id, profile_id, role)
  values (target_group_id, created_household_id, auth.uid(), assigned_role);

  raw_join_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));

  insert into public.household_join_codes (
    household_id,
    group_id,
    code_hash,
    created_by
  )
  values (
    created_household_id,
    target_group_id,
    encode(digest(raw_join_code, 'sha256'), 'hex'),
    auth.uid()
  );

  return query select created_household_id, raw_join_code;
end;
$$;

revoke all on function public.create_household_with_membership(uuid, text) from public;
grant execute on function public.create_household_with_membership(uuid, text) to authenticated;