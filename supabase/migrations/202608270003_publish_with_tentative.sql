-- Allow publishing a schedule with tentative (unconfirmed) driver assignments.
--
-- Previously, publish_schedule blocked if any tentative assignments existed
-- before the confirmation deadline, and auto-expired all tentative assignments
-- after the deadline. This forced the coordinator to wait for all drivers to
-- confirm before publishing — or lose all unconfirmed drivers to expiry.
--
-- New behavior: the coordinator can publish at any time, with whatever mix of
-- confirmed/tentative drivers exists. Tentative drivers stay tentative on the
-- published schedule. The coordinator can chase them down after publishing.
-- If a driver later confirms, status flips to confirmed. If they decline, the
-- volunteer flow ("I can drive") kicks in for affected families.

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
  v_tentative_count integer := 0;
  v_is_coordinator boolean;
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

  -- Count tentative assignments (for informational return value)
  select count(*) into v_tentative_count
  from public.driver_assignments
  where schedule_version_id = p_version_id
    and status = 'tentative';

  -- Supersede any prior published version for this week
  update public.schedule_versions
  set status = 'superseded'
  where week_id = v_week_id
    and group_id = p_group_id
    and status = 'published'
    and id != p_version_id;

  -- Publish the new version (tentative assignments stay tentative)
  update public.schedule_versions
  set status = 'published', published_at = now()
  where id = p_version_id;

  -- Audit
  insert into public.audit_events (group_id, actor_profile_id, action, entity_type, entity_id, details)
  values (p_group_id, auth.uid(), 'schedule_published', 'schedule_version', p_version_id,
    jsonb_build_object('version_number', v_version_number, 'tentative_count', v_tentative_count));

  return jsonb_build_object('success', true, 'tentative_count', v_tentative_count);
end;
$$;

revoke all on function public.publish_schedule(uuid, uuid) from public, authenticated;
grant execute on function public.publish_schedule(uuid, uuid) to authenticated;

-- Also unschedule the expire-unconfirmed-assignments cron if it's running
-- (may have already been unscheduled, so wrap in exception handler)
do $$
begin
  perform cron.unschedule('expire-unconfirmed-assignments');
exception when others then
  null;
end $$;