-- Delete trips on no-school dates for the pilot group.
-- The pre-seed migration (202607310003) created trips for every Mon–Fri in
-- the 2026-27 school year, including days when school is closed. The app
-- now hardcodes those dates in src/lib/school-calendar.ts and skips them
-- in createWeekWithTrips, but the pre-seeded rows must be removed so the
-- scheduler does not try to cover days with no school.
-- Idempotent: DELETE is a no-op on re-run once the rows are gone.

delete from public.trips
where group_id = 'c1000000-0000-4000-8000-000000000001'::uuid
  and service_date in (
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
  );