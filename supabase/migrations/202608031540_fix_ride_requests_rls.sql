-- Fix ride_requests RLS: split ALL policy into INSERT/UPDATE/DELETE.
--
-- The original ride_requests_manage_household policy was cmd: ALL with
-- WITH CHECK (created_by = auth.uid()) AND (...). The created_by check
-- is correct for INSERT but wrong for UPDATE — it blocks one parent
-- from toggling a ride need created by another parent in the same
-- household. This matches the children/vehicles pattern: INSERT checks
-- created_by, UPDATE/DELETE only check household membership.

drop policy if exists "ride_requests_manage_household" on public.ride_requests;

create policy "ride_requests_insert_household"
  on public.ride_requests for insert to authenticated
  with check (
    (created_by = auth.uid())
    and (
      exists (
        select 1 from public.weekly_checkins checkin
        where checkin.id = ride_requests.checkin_id
          and is_household_member(checkin.household_id)
      )
      or is_group_coordinator(group_id)
    )
  );

create policy "ride_requests_update_household"
  on public.ride_requests for update to authenticated
  using (
    exists (
      select 1 from public.weekly_checkins checkin
      where checkin.id = ride_requests.checkin_id
        and is_household_member(checkin.household_id)
    )
    or is_group_coordinator(group_id)
  )
  with check (
    exists (
      select 1 from public.weekly_checkins checkin
      where checkin.id = ride_requests.checkin_id
        and is_household_member(checkin.household_id)
    )
    or is_group_coordinator(group_id)
  );

create policy "ride_requests_delete_household"
  on public.ride_requests for delete to authenticated
  using (
    exists (
      select 1 from public.weekly_checkins checkin
      where checkin.id = ride_requests.checkin_id
        and is_household_member(checkin.household_id)
    )
    or is_group_coordinator(group_id)
  );