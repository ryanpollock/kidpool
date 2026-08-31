-- Auto-publish the schedule Sunday 7 PM Pacific with tentative drivers intact.
--
-- 1. Updates publish_schedule_internal to remove the tentative gate and
--    auto-expiry (same change as publish_schedule in migration 202608270003).
--    This allows the cron to publish with unconfirmed drivers still tentative.
--
-- 2. Creates auto_publish_sunday() which:
--    - Finds the latest draft version for the upcoming week
--    - If already published, does nothing (no-op)
--    - Publishes the draft as-is (no surgical regeneration, no expiry)
--    - POSTs to /send-push with type="published" to trigger the
--      "schedule published" email + push to all families
--
-- 3. Schedules the cron at Sunday 7 PM Pacific (2:00/3:00 UTC Monday,
--    DST-proofed dual UTC).

-- ── 1. Update publish_schedule_internal ───────────────────────
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
  v_tentative_count integer := 0;
begin
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
  values (p_group_id, p_actor_id, 'schedule_published', 'schedule_version', p_version_id,
    jsonb_build_object('version_number', v_version_number, 'tentative_count', v_tentative_count, 'source', 'auto'));

  return jsonb_build_object('success', true, 'tentative_count', v_tentative_count);
end;
$$;

revoke all on function public.publish_schedule_internal(uuid, uuid, uuid) from public, authenticated;

-- ── 2. Create auto_publish_sunday() ──────────────────────────
-- Replaces publish_and_update_schedule() which called surgical mode.
-- This new function publishes the latest draft as-is — no regeneration,
-- no expiry of tentative drivers. If the latest version is already
-- published (coordinator published manually), it's a no-op.
create or replace function public.auto_publish_sunday()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_week record;
  v_version record;
  v_result jsonb;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return;
  end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets
  where name = 'cron_edge_base_url'
  limit 1;

  if v_base_url is null then
    raise notice 'No cron_edge_base_url found in vault';
    return;
  end if;

  -- Find the next upcoming week per group
  for v_week in
    select distinct on (w.group_id) w.id as week_id, w.group_id
    from public.weeks w
    where w.starts_on > (now() at time zone 'America/Los_Angeles')::date
      and exists (select 1 from public.trips t where t.week_id = w.id)
    order by w.group_id, w.starts_on asc
  loop
    -- Find the latest version for this week
    select id, version_number, status into v_version
    from public.schedule_versions
    where week_id = v_week.week_id and group_id = v_week.group_id
    order by version_number desc
    limit 1;

    -- If no version exists, skip
    if v_version.id is null then
      raise notice 'No schedule version found for week %', v_week.week_id;
      continue;
    end if;

    -- If already published (coordinator published manually), skip
    if v_version.status = 'published' then
      raise notice 'Week % already published, skipping', v_week.week_id;
      continue;
    end if;

    -- Publish the draft as-is (tentative drivers stay tentative)
    select public.publish_schedule_internal(
      v_week.group_id, v_version.id, null
    ) into v_result;

    -- Trigger "schedule published" email + push to all families
    perform net.http_post(
      url := v_base_url || '/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object(
        'type', 'published',
        'version_id', v_version.id
      ),
      timeout_milliseconds := 120000
    );
  end loop;
end;
$$;

revoke all on function public.auto_publish_sunday() from public, authenticated;

-- ── 3. Schedule the cron ──────────────────────────────────────
-- Sunday 7 PM Pacific = 2:00/3:00 UTC Monday (DST-proofed dual UTC)
-- Unschedule the old function first (if it exists)
do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then
  null;
end $$;

-- Also clean up the old publish_and_update_schedule function
drop function if exists public.publish_and_update_schedule();

select cron.schedule(
  'auto-publish-sunday',
  '0 2,3 * * 1',
  $$ select public.auto_publish_sunday(); $$
);