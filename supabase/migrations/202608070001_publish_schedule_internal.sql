-- Service-role publish RPC for automated (cron-triggered) schedule publication.
-- Identical to publish_schedule but:
--   1. No auth.uid() coordinator check — caller is trusted (service role).
--   2. Takes explicit p_actor_id for the audit row (null for system cron).
--   3. Revoked from authenticated — only the service role can call it.
--
-- The Edge Function calls this when auto-publishing via the cron path.
-- The frontend's manual publish button continues to use publish_schedule
-- (which checks auth.uid() for coordinator).

create or replace function public.publish_schedule_internal(
  p_group_id uuid,
  p_version_id uuid,
  p_actor_id uuid
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
  v_confirmation_deadline timestamptz;
  v_tentative_count integer;
begin
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

  -- Same gate as publish_schedule: if tentative assignments exist and the
  -- deadline hasn't passed, block. The Edge Function checks this before
  -- calling, but the RPC enforces it as a safety net.
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
  values (p_group_id, p_actor_id, 'schedule_published', 'schedule_version', p_version_id,
    jsonb_build_object('version_number', v_version_number, 'expired_count', v_expired_count, 'source', 'auto'));

  return jsonb_build_object('success', true, 'expired_count', v_expired_count);
end;
$$;

revoke all on function public.publish_schedule_internal(uuid, uuid, uuid) from public, authenticated;