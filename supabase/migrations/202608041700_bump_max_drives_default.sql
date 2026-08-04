-- Bump max_drives from 0 (old default, meaning "no drives") to 10
-- (column max, effectively unlimited). The max_drives UI input was
-- removed from the Check-in screen to prevent abuse during the pilot.
-- New checkins default to 10 via getOrCreateCheckin; this bumps
-- existing rows that still have the old 0 default.

UPDATE public.weekly_checkins SET max_drives = 10 WHERE max_drives = 0;