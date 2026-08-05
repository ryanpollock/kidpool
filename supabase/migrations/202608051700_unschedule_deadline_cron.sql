-- Unschedule the hourly deadline-reminder cron.
-- The send-push deadline_reminder type combined with the uncovered query
-- scoping bug could send false "your child doesn't have a ride" pushes to
-- pilot families. We're not relying on push for the pilot (coordinator
-- texts families directly). Can re-enable once send-push is fixed and
-- the cron is rewritten to be environment-aware (it's currently hard-coded
-- to the production Supabase URL, which would also fire from staging).

select cron.unschedule('checkin-deadline-reminder');