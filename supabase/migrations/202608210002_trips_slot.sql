-- Add slot column to trips so we can distinguish multiple afternoon trips
-- on the same day.  'am' = morning, 'pm_early' = 4:20 PM, 'pm_late' = 5:15 PM.
--
-- The existing unique constraint (week_id, service_date, direction) prevents
-- two afternoon trips on the same day, so we replace it with
-- (week_id, service_date, slot).
--
-- A trigger auto-sets slot from direction for any insert that doesn't
-- specify slot, preserving backward compatibility with existing code.

begin;

-- 1. Add nullable column
alter table public.trips add column slot text;

-- 2. Backfill existing trips
update public.trips set slot = 'am' where direction = 'morning';
update public.trips set slot = 'pm_late' where direction = 'afternoon';

-- 3. Add trigger to auto-set slot from direction when not provided
create or replace function public.set_trip_slot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.slot is null then
    new.slot := case when new.direction = 'morning' then 'am' else 'pm_late' end;
  end if;
  return new;
end;
$$;

create trigger trips_set_slot
before insert on public.trips
for each row execute function public.set_trip_slot();

-- 4. Make NOT NULL and add CHECK
alter table public.trips
  alter column slot set not null,
  add constraint trips_slot_check check (slot in ('am', 'pm_early', 'pm_late'));

-- 5. Replace unique constraint
alter table public.trips drop constraint trips_week_id_service_date_direction_key;
alter table public.trips
  add constraint trips_week_id_service_date_slot_key unique (week_id, service_date, slot);

-- 6. Add index for slot-based queries
create index trips_group_date_slot_idx on public.trips (group_id, service_date, slot);

commit;