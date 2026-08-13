-- Pre-seed the full school year: Aug 2026 – Jul 2027.
-- Creates a week row for every Monday and 10 trips per week (5 days × 2 directions).
-- Morning: 08:40 meeting, 08:45 departure (Midtown Terrace → Presidio)
-- Afternoon: 17:15 meeting, 17:20 departure (Presidio → Midtown Terrace)
-- Idempotent: safe to re-run. Existing weeks are kept, existing trips are
-- updated to the correct times.

-- Step 1: Insert all weeks (Aug 2026 – Jul 2027)
-- Guard: only insert if the pilot group exists (makes this truly idempotent
-- on a fresh DB where seed.sql hasn't run yet).
insert into public.weeks (group_id, starts_on, status)
select 'c1000000-0000-4000-8000-000000000001'::uuid, d.date, 'open'
from generate_series('2026-08-03'::date, '2027-07-26'::date, interval '1 week') as d(date)
where exists (select 1 from public.groups where id = 'c1000000-0000-4000-8000-000000000001'::uuid)
on conflict (group_id, starts_on) do nothing;

-- Step 2: Insert/update morning trips for all weeks
insert into public.trips (
  group_id, week_id, service_date, direction,
  meeting_time, departure_time, origin, destination
)
select
  w.group_id,
  w.id,
  w.starts_on + make_interval(days => d.day_offset),
  'morning'::public.trip_direction,
  '08:40'::time,
  '08:45'::time,
  'Midtown Terrace Playground',
  'Presidio Middle School'
from public.weeks w
cross join generate_series(0, 4) as d(day_offset)
where w.group_id = 'c1000000-0000-4000-8000-000000000001'::uuid
  and w.starts_on between '2026-08-03' and '2027-07-26'
on conflict (week_id, service_date, direction) do update
  set meeting_time = excluded.meeting_time,
      departure_time = excluded.departure_time,
      origin = excluded.origin,
      destination = excluded.destination,
      updated_at = now();

-- Step 3: Insert/update afternoon trips for all weeks
insert into public.trips (
  group_id, week_id, service_date, direction,
  meeting_time, departure_time, origin, destination
)
select
  w.group_id,
  w.id,
  w.starts_on + make_interval(days => d.day_offset),
  'afternoon'::public.trip_direction,
  '17:15'::time,
  '17:20'::time,
  'Presidio Middle School',
  'Midtown Terrace Playground'
from public.weeks w
cross join generate_series(0, 4) as d(day_offset)
where w.group_id = 'c1000000-0000-4000-8000-000000000001'::uuid
  and w.starts_on between '2026-08-03' and '2027-07-26'
on conflict (week_id, service_date, direction) do update
  set meeting_time = excluded.meeting_time,
      departure_time = excluded.departure_time,
      origin = excluded.origin,
      destination = excluded.destination,
      updated_at = now();