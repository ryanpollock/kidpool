-- Add preference column to ride_requests.
-- 'specific' = child needs a ride on this exact trip (existing behavior)
-- 'either'  = child needs a ride on either afternoon trip; the scheduler
--              assigns them to whichever afternoon trip has capacity,
--              trying the earlier trip first.
-- Existing rows default to 'specific', preserving current behavior.

alter table public.ride_requests
  add column preference text not null default 'specific'
  check (preference in ('specific', 'either'));