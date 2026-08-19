-- Drive status for "On my way" (driver) and "Ready" (rider) roll-call.
--
-- Each row is a single status set by one person for one drive:
--   - Driver status: child_id is NULL, status = 'on_my_way'
--   - Rider status: child_id is set, status = 'ready'
--
-- The UI time-gates visibility (within 6h before → 30min after meeting time)
-- and auto-resets by simply not showing stale rows outside that window.
-- Rows persist for auditing but are not surfaced outside the window.
--
-- RLS:
--   - SELECT: any active member of the drive's group (so all parents in the
--     carpool see the roll-call for drives they're affected by)
--   - INSERT: auth.uid() = profile_id AND (child_id is null OR child is in
--     the inserter's household) — drivers set their own status; parents set
--     their own children's status
--   - DELETE: auth.uid() = profile_id (take back your own status)

create table public.drive_status (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  driver_assignment_id uuid not null references public.driver_assignments(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  child_id uuid references public.children(id) on delete cascade,
  status text not null check (status in ('on_my_way', 'ready')),
  set_at timestamptz not null default now()
);

-- One driver "on my way" status per drive
create unique index drive_status_driver_unique
  on public.drive_status (driver_assignment_id)
  where child_id is null;

-- One "ready" status per child per drive
create unique index drive_status_rider_unique
  on public.drive_status (driver_assignment_id, child_id)
  where child_id is not null;

alter table public.drive_status enable row level security;

-- SELECT: any active member of the drive's group
create policy drive_status_select_group
  on public.drive_status for select to authenticated
  using (
    exists (
      select 1 from public.memberships m
      where m.group_id = drive_status.group_id
        and m.profile_id = auth.uid()
        and m.status = 'active'
    )
  );

-- INSERT: must be setting your own status, and for rider status the child
-- must be in your household
create policy drive_status_insert_self
  on public.drive_status for insert to authenticated
  with check (
    profile_id = auth.uid()
    and (
      child_id is null
      or exists (
        select 1 from public.children c
        join public.memberships m on m.household_id = c.household_id
        where c.id = drive_status.child_id
          and m.profile_id = auth.uid()
          and m.status = 'active'
      )
    )
  );

-- DELETE: take back your own status only
create policy drive_status_delete_self
  on public.drive_status for delete to authenticated
  using (profile_id = auth.uid());

-- Grant table privileges to the authenticated role.
-- RLS policies are checked AFTER table-level privileges, so without these
-- grants the policies never get a chance to run.
grant select, insert, delete on public.drive_status to authenticated;