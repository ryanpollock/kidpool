-- Change the Sunday evening cron from full regeneration to surgical update.
--
-- The Sunday evening cron previously called generate_schedule_cron() which
-- triggers a full balanced-greedy-v2 re-optimization from scratch. This could
-- reshuffle all confirmed drives even though nothing changed for most of them.
--
-- Now it calls publish_and_update_schedule() which POSTs to /generate-schedule
-- with mode: "surgical". The Edge Function preserves all confirmed driver
-- assignments, fits new riders (from late check-ins) into spare car capacity,
-- and auto-publishes. No reshuffling of confirmed drives.
--
-- The Saturday draft generation (generate_schedule_cron at 0 14 * * 0) stays
-- unchanged — that's the right time for a fresh full optimization.

create or replace function public.publish_and_update_schedule()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_week record;
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

  -- Find the next upcoming week per group (same query as generate_schedule_cron)
  for v_week in
    select distinct on (w.group_id) w.id as week_id, w.group_id
    from public.weeks w
    where w.starts_on > (now() at time zone 'America/Los_Angeles')::date
      and exists (select 1 from public.trips t where t.week_id = w.id)
    order by w.group_id, w.starts_on asc
  loop
    perform net.http_post(
      url := v_base_url || '/generate-schedule',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object(
        'weekId', v_week.week_id,
        'source', 'cron',
        'mode', 'surgical'
      ),
      timeout_milliseconds := 120000
    );
  end loop;
end;
$$;

revoke all on function public.publish_and_update_schedule() from public, authenticated;

-- Reschedule the Sunday evening cron to use surgical update instead of
-- full regeneration. Same schedule time (8:30 PM Pacific, DST-proofed).
do $$
begin
  perform cron.unschedule('generate-schedule-sunday');
exception when others then null;
end $$;

select cron.schedule(
  'generate-schedule-sunday',
  '30 3,4 * * 1',
  $$ select public.publish_and_update_schedule(); $$
);