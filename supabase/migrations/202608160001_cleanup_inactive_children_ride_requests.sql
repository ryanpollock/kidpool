-- One-time cleanup: delete ride_requests for deactivated children.
-- The scheduler already excludes inactive children (children loaded with
-- active=true in generate-schedule/index.ts; orphaned ride_requests dropped
-- by childById.get filter in balanced-greedy-v2.ts), so these rows have no
-- scheduling or UI effect. This is pure data hygiene — DB queries that
-- join ride_requests to children no longer see phantom rows for kids who
-- have been removed from the carpool.
--
-- Idempotent: safe to re-run. Future deactivations via the deactivateChild
-- RPC now delete the child's ride_requests in the same call (see
-- carpool-repository.ts), so accumulation should not recur.
--
-- Known affected as of 2026-08-16 (production):
--   87acc1c0 Zadie Rose Mikecz (Ou Mikecz) — duplicate, deactivated 2026-08-15
--   ea70b751 Enzo Mikecz (Ou Mikecz) — deactivated
--   daea2f27 Selin Urhan — deactivated (already 0 rows)

delete from public.ride_requests
 where child_id in (select id from public.children where active = false);