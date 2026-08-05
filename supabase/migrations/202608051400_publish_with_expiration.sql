-- Replace the expiration cron with publish-time expiration.
-- The cron (every 15 min) was overkill — expiration only needs to happen
-- once, when the coordinator finalizes the schedule. This migration:
--   1. Unschedules the cron job
--   2. Adds a publish_schedule(group_id, version_id) RPC that atomically
--      expires tentative assignments, supersedes any prior published
--      version, and publishes the new one. Also enforces the gate:
--      if tentative assignments exist and the confirmation_deadline
--      hasn't passed, publish is blocked.

-- 1. Unschedule the cron job
do $$
begin
  select cron.unschedule('expire-unconfirmed-assignments');
exception when others then
  null;
end $$;

-- 2. Drop the old expire function (no longer called by cron)
drop function if exists public.expire_unconfirmed_assignments();

-- 3. Create the publish RPC
create or replace function public.publish_schedule(
  p_group_id uuid,
  p_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_week_id uuid;
  v_version_number integer;
  v_expired_count integer := 0;
  v_is_coordinator boolean;
  v_confirmation_deadline timestamptz;
  v_tentative_count integer;
begin
  -- Verify the caller is an active coordinator for this group
  select exists(
    select 1 from public.memberships
    where group_id = p_group_id
      and profile_id = auth.uid()
      and role = 'coordinator'
      and status = 'active'
  ) into v_is_coordinator;

  if not v_is_coordinator then
    return jsonb_build_object('error', 'not_coordinator');
  end if;

  -- Load the version
  select week_id, version_number into v_week_id, v_version_number
  from public.schedule_versions
  where id = p_version_id and group_id = p_group_id;

  if v_week_id is null then
    return jsonb_build_object('error', 'version_not_found');
  end if;

  -- Load the confirmation deadline
  select confirmation_deadline into v_confirmation_deadline
  from public.weeks where id = v_week_id;

  -- Count tentative assignments on this version
  select count(*) into v_tentative_count
  from public.driver_assignments
  where schedule_version_id = p_version_id
    and status = 'tentative';

  -- Gate: if there are tentative assignments and the deadline hasn't
  -- passed, block. The coordinator must wait for confirmations or
  -- for the deadline to expire.
  if v_tentative_count > 0 and (v_confirmation_deadline is null or now() < v_confirmation_deadline) then
    return jsonb_build_object('error', 'tentative_awaiting_confirmation', 'count', v_tentative_count);
  end if;

  -- Expire any remaining tentative assignments (deadline has passed)
  update public.driver_assignments
  set status = 'expired', updated_at = now()
  where schedule_version_id = p_version_id
    and status = 'tentative';

  get diagnostics v_expired_count = row_count;

  -- Supersede any prior published version for this week
  update public.schedule_versions
  set status = 'superseded'
  where week_id = v_week_id
    and group_id = p_group_id
    and status = 'published'
    and id != p_version_id;

  -- Publish the new version
  update public.schedule_versions
  set status = 'published', published_at = now()
  where id = p_version_id;

  -- Audit
  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (p_group_id, auth.uid(), 'schedule_published', 'schedule_version', p_version_id,
    jsonb_build_object('version_number', v_version_number, 'expired_count', v_expired_count));

  return jsonb_build_object('success', true, 'expired_count', v_expired_count);
end;
$$;

grant execute on function public.publish_schedule(uuid, uuid) to authenticated;