-- Exchange 7: Allow regenerating a household join code from the Account screen.
-- The original code is only shown once during onboarding and stored as a
-- SHA-256 hash, so it cannot be recovered. This RPC lets a household member
-- generate a new code at any time.

create or replace function public.regenerate_join_code(
  target_household_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_join_code text;
  target_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Verify the caller is an active member of this household
  if not exists (
    select 1 from public.memberships
    where household_id = target_household_id
      and profile_id = auth.uid()
      and status = 'active'
  ) then
    raise exception 'You are not a member of this household';
  end if;

  -- Get the group_id for this household
  select group_id into target_group_id
  from public.households
  where id = target_household_id;

  if target_group_id is null then
    raise exception 'Household not found';
  end if;

  -- Generate a new random 10-character code
  raw_join_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));

  -- Update the existing join code row with the new hash
  update public.household_join_codes
  set code_hash = encode(digest(raw_join_code, 'sha256'), 'hex'),
      created_by = auth.uid(),
      created_at = now(),
      expires_at = null
  where household_id = target_household_id;

  -- If no existing row (edge case), insert one
  if not found then
    insert into public.household_join_codes (
      household_id,
      group_id,
      code_hash,
      created_by
    )
    values (
      target_household_id,
      target_group_id,
      encode(digest(raw_join_code, 'sha256'), 'hex'),
      auth.uid()
    );
  end if;

  -- Record audit event
  insert into public.audit_events (
    group_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id
  )
  values (
    target_group_id,
    auth.uid(),
    'join_code_regenerated',
    'household',
    target_household_id::text
  );

  return raw_join_code;
end;
$$;

revoke all on function public.regenerate_join_code(uuid) from public;
grant execute on function public.regenerate_join_code(uuid) to authenticated;