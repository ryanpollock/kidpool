-- Fix deadlines on pre-seeded weeks to use Pacific time.
-- The backfill migration (202608020002) used starts_on::timestamptz (midnight UTC)
-- plus 15 hours, which produced 3 PM UTC = 8 AM Pacific — wrong timezone.
-- This migration recalculates:
--   checkin_deadline = Saturday before at 3 PM Pacific
--   confirmation_deadline = Sunday before at 8 PM Pacific
-- Pacific is PDT (UTC-7) in summer, PST (UTC-8) in winter.
-- The AT TIME ZONE construct handles DST automatically.

update public.weeks
set
  checkin_deadline = ((starts_on - 2)::text || ' 15:00:00')::timestamp at time zone 'America/Los_Angeles',
  confirmation_deadline = ((starts_on - 1)::text || ' 20:00:00')::timestamp at time zone 'America/Los_Angeles'
where starts_on is not null;