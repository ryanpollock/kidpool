-- Update Wednesday pm_early trips to 2:10 PM (early dismissal) starting Sep 7, 2026.
-- Wednesdays before Sep 9 stay at 4:20 PM.
-- All non-Wednesday pm_early trips stay at 4:20 PM.

UPDATE public.trips
SET meeting_time = '14:10', departure_time = '14:15'
WHERE slot = 'pm_early'
  AND service_date >= '2026-09-09'
  AND extract(dow from service_date) = 3
  AND group_id = 'c1000000-0000-4000-8000-000000000001';