-- Add default ride needs column to households.
-- Stores a JSON array of entries (one per child per day-of-week per direction)
-- representing the household's standard weekly ride needs.
-- Auto-populates new weeks via the app's applyDefaultRideNeeds method.
-- No new RLS needed — households already has household member write policy.

alter table public.households
  add column if not exists default_ride_needs jsonb default '[]'::jsonb;