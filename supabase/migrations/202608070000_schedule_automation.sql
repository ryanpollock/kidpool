-- Schedule automation: auto-generate the draft after the check-in deadline
-- (Sat 3 PM Pacific) and auto-generate + auto-publish after the confirmation
-- deadline (Sun 8 PM Pacific). Removes the coordinator as a blocker for
-- schedule generation and publication.
--
-- Cron times are in UTC, chosen to fall AFTER the Pacific deadlines in both
-- PDT (UTC-7) and PST (UTC-8):
--   Sat 23:00 UTC = Sat 3 PM PST / 4 PM PDT  (after 3 PM check-in deadline)
--   Mon 05:00 UTC = Sun 8 PM PST / 9 PM PDT  (after 8 PM confirmation deadline)
--
-- The wrapper reads `cron_secret` and `cron_edge_base_url` from vault so it
-- is environment-aware (fixes the hardcoded-URL bug from 202608020009).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Wrapper function: finds the next upcoming week per group and POSTs to the
-- generate-schedule Edge Function with the cron secret.
create or replace function public.generate_schedule_cron()
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

  -- Find the next upcoming week per group (starts_on > today in Pacific).
  -- Skip weeks with no trips (break weeks). DISTINCT ON keeps the earliest
  -- upcoming week per group.
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
      body := jsonb_build_object('weekId', v_week.week_id, 'source', 'cron')
    );
  end loop;
end;
$$;

revoke all on function public.generate_schedule_cron() from public, authenticated;

-- Saturday run: generate the first complete draft after the check-in deadline.
select cron.schedule(
  'generate-schedule-saturday',
  '0 23 * * 6',
  $$ select public.generate_schedule_cron(); $$
);

-- Monday run (fires Sunday evening Pacific): regenerate to capture late
-- check-ins and last-minute confirmations, then auto-publish.
select cron.schedule(
  'generate-schedule-sunday',
  '0 5 * * 1',
  $$ select public.generate_schedule_cron(); $$
);