-- ensure_drive_thread: find-or-create a group chat for one drive's
-- parents (feature decision 2026-09-30).
--
-- The Home "Today's drives" card and the drive detail screen get a
-- "Message parents" button. Tapping it must open ONE shared thread with
-- the driver + the parents of every child riding that car — not mint a
-- duplicate thread per tap. DM/everyone/agent threads all have ensure
-- RPCs; group threads were the gap (create_group_thread duplicates).
--
-- Audience (all on the given schedule version + trip):
--   - the drive's active assignment driver
--   - every active member profile of each rider child's household
-- The caller must BE one of those people (driver or a riding family) and
-- is enrolled by create_group_thread as the thread creator.
--
-- Dedup: an existing group thread in the same group with the SAME drive
-- title AND the exact same participant set is reused. Roster drift (a kid
-- added/removed) produces a different set, so the next tap creates a fresh
-- thread that includes everyone — the old thread is left intact rather
-- than silently excluding late-added parents (there is no add-participant
-- RPC). Title carries the date + slot/time so two different days' drives
-- with identical parent sets never collide.
--
-- Thread creation reuses create_group_thread: participant validation
-- (active members, <=20, caller excluded from the selection), enrollment,
-- and the mandated Crewmate disclosure note all come along (AGENTS.md:
-- "every thread creation posts a system note ... Do not remove the
-- disclosure.").

begin;

create or replace function public.ensure_drive_thread(
  p_trip_id uuid,
  p_schedule_version_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip public.trips;
  v_group_id uuid;
  v_caller uuid := auth.uid();
  v_driver_profile_id uuid;
  v_member_ids uuid[];
  v_all_ids uuid[];
  v_target_ids uuid[];
  v_title text;
  v_existing uuid;
  v_set_size integer;
begin
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  select * into v_trip from public.trips where id = p_trip_id;
  if v_trip.id is null then
    raise exception 'Trip not found';
  end if;
  v_group_id := v_trip.group_id;

  if not exists (
    select 1 from public.memberships
    where group_id = v_group_id
      and profile_id = v_caller
      and status = 'active'
  ) then
    raise exception 'You are not an active member of this group';
  end if;

  -- The drive: the active assignment on the given version for this trip
  select driver_profile_id into v_driver_profile_id
  from public.driver_assignments
  where trip_id = p_trip_id
    and schedule_version_id = p_schedule_version_id
    and status in ('tentative', 'confirmed')
  order by created_at desc
  limit 1;

  if v_driver_profile_id is null then
    raise exception 'This drive is not on the current schedule';
  end if;

  -- Parents of the kids riding this drive (rider households -> active members)
  select array_agg(distinct m.profile_id) into v_member_ids
  from public.memberships m
  where m.group_id = v_group_id
    and m.status = 'active'
    and m.household_id in (
      select c.household_id
      from public.rider_assignments ra
      join public.children c on c.id = ra.child_id
      where ra.trip_id = p_trip_id
        and ra.schedule_version_id = p_schedule_version_id
    );

  -- Driver + rider parents; a driving parent appears via both paths, hence
  -- the final distinct.
  with combined as (
    select profile_id from public.memberships
    where group_id = v_group_id and profile_id = v_driver_profile_id and status = 'active'
    union
    select unnest(coalesce(v_member_ids, '{}'::uuid[]))
  )
  select array_agg(distinct profile_id) into v_all_ids from combined;

  if v_all_ids is null then
    v_all_ids := array[v_driver_profile_id]::uuid[];
  end if;

  -- Stake guard: the caller must be the driver or a riding family's member
  if not (v_caller = any(v_all_ids)) then
    raise exception 'Only the driver or a riding family can start this chat';
  end if;

  -- create_group_thread enrolls the caller as creator; the selection must
  -- not include them (their co-parent stays in).
  select array_agg(distinct x) into v_target_ids
  from unnest(v_all_ids) x
  where x <> v_caller;

  if v_target_ids is null then
    raise exception 'No other parents to message on this drive';
  end if;

  -- Title: date + slot. "Wed Sep 30 morning drive" / "Wed Sep 30 04:50 PM
  -- drive" (afternoon cards carry the time so pm_early, pm_late, and
  -- custom extra drives never share a title).
  v_title := case
    when v_trip.direction = 'morning' then
      to_char(v_trip.service_date, 'Dy Mon DD') || ' morning drive'
    else
      to_char(v_trip.service_date, 'Dy Mon DD') || ' ' || to_char(v_trip.meeting_time, 'HH12:MI AM') || ' drive'
  end;

  v_set_size := coalesce(array_length(v_all_ids, 1), 0);

  -- Find-or-create: same group + same title + exact same participant set.
  select t.id into v_existing
  from public.chat_threads t
  where t.group_id = v_group_id
    and t.kind = 'group'
    and t.title = v_title
    and (
      select count(distinct cp.profile_id)
      from public.chat_participants cp
      where cp.thread_id = t.id
    ) = v_set_size
    and (
      select count(distinct cp.profile_id)
      from public.chat_participants cp
      where cp.thread_id = t.id
        and cp.profile_id = any(v_all_ids)
    ) = v_set_size
  order by t.created_at desc
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  return public.create_group_thread(v_target_ids, v_title);
end;
$$;

revoke all on function public.ensure_drive_thread(uuid, uuid) from public;
grant execute on function public.ensure_drive_thread(uuid, uuid) to authenticated;

commit;