-- Backfill slot field into default_drive_preferences and default_ride_needs
-- JSONB arrays on profiles and households tables.
--
-- Existing entries were saved before the slot column existed and don't have
-- a slot field. The new DrivePreferenceGrid and RideNeedsGrid match entries
-- by slot, so without this backfill, existing families can't update their
-- driving preferences (the grid can't find the entry to update).
--
-- For each entry missing slot, infer from direction:
--   morning → 'am'
--   afternoon → 'pm_late'
--
-- For default_ride_needs, afternoon entries without slot become 'pm_late'
-- (not 'pm_either' — we preserve the existing single-afternoon behavior).

begin;

-- Backfill default_drive_preferences on profiles
update public.profiles
set default_drive_preferences = (
  select jsonb_agg(
    case
      when elem ? 'slot' then elem
      else elem || jsonb_build_object('slot', case when elem->>'direction' = 'morning' then 'am' else 'pm_late' end)
    end
  )
  from jsonb_array_elements(default_drive_preferences) as elem
)
where default_drive_preferences is not null
  and jsonb_typeof(default_drive_preferences) = 'array'
  and exists (
    select 1 from jsonb_array_elements(default_drive_preferences) as elem
    where not (elem ? 'slot')
  );

-- Backfill default_ride_needs on households
update public.households
set default_ride_needs = (
  select jsonb_agg(
    case
      when elem ? 'slot' then elem
      else elem || jsonb_build_object('slot', case when elem->>'direction' = 'morning' then 'am' else 'pm_late' end)
    end
  )
  from jsonb_array_elements(default_ride_needs) as elem
)
where default_ride_needs is not null
  and jsonb_typeof(default_ride_needs) = 'array'
  and exists (
    select 1 from jsonb_array_elements(default_ride_needs) as elem
    where not (elem ? 'slot')
  );

commit;