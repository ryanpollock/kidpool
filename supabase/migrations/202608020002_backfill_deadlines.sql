-- Backfill checkin_deadline and confirmation_deadline for existing weeks.
-- Deadlines: check-in by Saturday 3 PM, confirmation by Sunday 3 PM before the week starts.
-- These columns exist in the schema but were never populated.

update public.weeks
set
  checkin_deadline = (starts_on::timestamptz - interval '2 days')::timestamptz
    + interval '15 hours',
  confirmation_deadline = (starts_on::timestamptz - interval '1 day')::timestamptz
    + interval '15 hours'
where checkin_deadline is null
  and confirmation_deadline is null;