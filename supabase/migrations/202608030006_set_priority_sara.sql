-- Mark Sara Pollock as a priority child in the scheduling algorithm.
-- Name match (not ID) so this is idempotent and survives row recreation:
-- if Sara is deleted and re-added via the app, re-running this migration
-- re-applies the flag. Safe in this pilot: exactly one Sara Pollock per DB.
--
-- Run after 202608030005_child_is_priority.sql. Apply per environment
-- (staging first, then production) using:
--   supabase db query --linked -f supabase/migrations/202608030006_set_priority_sara.sql

update public.children
  set is_priority = true
  where first_name = 'Sara'
    and last_name = 'Pollock';