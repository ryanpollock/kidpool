-- Add pm_early (4:20 PM) trips for all existing pre-seeded weeks.
-- This runs AFTER the slot column and (week_id, service_date, slot) constraint
-- exist, so it can safely insert a second afternoon trip per day.
--
-- The preseed migration (202607310003) only creates morning + pm_late trips
-- because it runs before the slot column exists. This migration adds the
-- missing pm_early trips so the pre-seeded school year has all 3 slots.
--
-- Holidays are excluded — the same 27 no-school dates that
-- 202608031249_delete_no_school_trips.sql removed and that
-- src/lib/school-calendar.ts hardcodes. Without this exclusion, pm_early
-- trips would be created on days when there is no school.
--
-- Idempotent: safe to re-run. Existing pm_early trips are updated.

insert into public.trips (
  group_id, week_id, service_date, direction, slot,
  meeting_time, departure_time, origin, destination
)
select
  w.group_id,
  w.id,
  w.starts_on + make_interval(days => d.day_offset),
  'afternoon'::public.trip_direction,
  'pm_early',
  '16:20'::time,
  '16:25'::time,
  'Presidio Middle School',
  'Midtown Terrace Playground'
from public.weeks w
cross join generate_series(0, 4) as d(day_offset)
where w.group_id = 'c1000000-0000-4000-8000-000000000001'::uuid
  and w.starts_on between '2026-08-03' and '2027-07-26'
  and (w.starts_on + make_interval(days => d.day_offset))::date not in (
    '2026-08-17',              -- First day of school
    '2026-09-07',              -- Labor Day
    '2026-10-12',              -- Indigenous Peoples' Day
    '2026-11-11',              -- Veterans Day
    '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', -- Thanksgiving Break
    '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25',
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',              -- Winter Break
    '2027-01-01',              -- New Year's Day
    '2027-01-18',              -- MLK Jr. Day
    '2027-02-05',              -- Lunar New Year
    '2027-02-15',              -- Presidents' Day
    '2027-03-26',              -- Spring Break
    '2027-03-29', '2027-03-30', '2027-03-31', '2027-04-01', '2027-04-02', -- Spring Break
    '2027-05-31'               -- Memorial Day
  )
on conflict (week_id, service_date, slot) do update
  set meeting_time = excluded.meeting_time,
      departure_time = excluded.departure_time,
      origin = excluded.origin,
      destination = excluded.destination,
      updated_at = now();