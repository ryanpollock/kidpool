-- Fix the column default for max_drives.
-- The backfill migration (202608041700) updated existing rows from 0 to 10,
-- but the column default is still 0 (from the foundation migration).
-- A future code path that inserts a weekly_checkins row without
-- explicitly setting max_drives would silently create a household
-- that can't drive (max_drives=0). Set the default to 10 (column max,
-- effectively unlimited for the pilot's 5-trip weeks).

alter table public.weekly_checkins alter column max_drives set default 10;