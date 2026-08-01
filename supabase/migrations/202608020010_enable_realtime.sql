-- Enable Supabase Realtime for tables used in co-parent check-in sync.
-- By default, Supabase only enables realtime on a few system tables.
-- These tables need to be added to the supabase_realtime publication
-- for the PlanScreen postgres_changes subscription to receive events.

alter publication supabase_realtime add table public.weekly_checkins;
alter publication supabase_realtime add table public.ride_requests;
alter publication supabase_realtime add table public.driver_availability;