-- Remove the restore-released logic from respond_to_driver_assignment and
-- fix the data so the volunteer (last person who had the drive) can re-accept.
--
-- PROBLEM with PR #93: When a volunteer declined, the restore logic moved
-- riders BACK to the original driver's 'released' assignment and set it to
-- 'declined'. This let the ORIGINAL driver re-accept, but left the VOLUNTEER
-- with a 'declined' assignment and 0 riders — the volunteer couldn't
-- re-accept. The correct behavior: riders stay on the volunteer's 'declined'
-- assignment so the LAST person who had the drive can re-accept. The original
-- driver's assignment stays 'released' and can take over via "I can drive".
--
-- This migration:
-- 1. Rewrites respond_to_driver_assignment WITHOUT the restore logic
--    (reverts to the 202608052100 version, which was correct)
-- 2. One-time data fix: for any 'released' assignment that was restored to
--    'declined' by PR #93's logic, move riders back to the volunteer's
--    'declined' assignment and set the original back to 'released'
--
-- Idempotent: uses CREATE OR REPLACE. Safe to re-run.

-- ── 1. Rewrite respond_to_driver_assignment (revert to pre-#93 logic) ──

create or replace function public.respond_to_driver_assignment(
  target_assignment_id uuid,
  driver_response public.confirmation_response,
  decline_reason text default null
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment public.driver_assignments;
  v_rider_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into assignment
  from public.driver_assignments
  where id = target_assignment_id
  for update;

  if assignment.id is null then
    raise exception 'Driver assignment not found';
  end if;

  if assignment.driver_profile_id <> auth.uid() then
    raise exception 'Only the assigned driver can respond';
  end if;

  -- Guard: only allow re-response when the assignment is still actionable.
  -- 'tentative'/'confirmed'/'declined'/'expired' may be re-responded.
  -- 'released' (a volunteer took over a declined drive) is final and
  -- cannot be resurrected.
  if assignment.status not in ('tentative', 'confirmed', 'declined', 'expired') then
    raise exception 'This assignment can no longer be responded to (status: %)', assignment.status;
  end if;

  -- Guard for expired: a rider family may have already taken over via
  -- volunteer_for_uncovered_trip (expired kids are genuinely uncovered
  -- from the server's perspective). If the rider rows have been moved
  -- away, re-accept would resurrect a zero-rider confirmed assignment.
  -- Block that with a clear message.
  if assignment.status = 'expired' then
    select count(*) into v_rider_count
    from public.rider_assignments
    where driver_assignment_id = assignment.id;

    if v_rider_count = 0 then
      raise exception 'Another driver has already taken this drive';
    end if;
  end if;

  -- Upsert the confirmation row (unique on driver_assignment_id).
  -- This allows changing a prior response.
  insert into public.driver_confirmations (
    group_id,
    driver_assignment_id,
    driver_profile_id,
    response,
    decline_reason
  )
  values (
    assignment.group_id,
    assignment.id,
    auth.uid(),
    driver_response,
    case
      when driver_response = 'declined' and decline_reason is not null
        then left(trim(decline_reason), 500)
      else null
    end
  )
  on conflict (driver_assignment_id)
  do update set
    response = excluded.response,
    decline_reason = excluded.decline_reason,
    responded_at = now();

  update public.driver_assignments
  set status = case
    when driver_response = 'confirmed' then 'confirmed'::public.assignment_status
    else 'declined'::public.assignment_status
  end
  where id = assignment.id
  returning * into assignment;

  insert into public.audit_events (
    group_id, actor_profile_id, action, entity_type, entity_id, details
  )
  values (
    assignment.group_id, auth.uid(), 'driver_assignment_responded', 'driver_assignment',
    assignment.id::text,
    jsonb_build_object(
      'response', driver_response,
      'decline_reason',
        case
          when driver_response = 'declined' and decline_reason is not null
            then left(trim(decline_reason), 500)
          else null
        end
    )
  );

  return assignment;
end;
$$;

revoke all on function public.respond_to_driver_assignment(uuid, public.confirmation_response, text) from public;
grant execute on function public.respond_to_driver_assignment(uuid, public.confirmation_response, text) to authenticated;

-- ── 2. One-time data fix: undo PR #93's rider restoration ──────
-- For any pair where a 'declined' assignment (restored from 'released' by
-- PR #93) has riders AND another 'declined' assignment for the same trip +
-- version has 0 riders: move riders to the 0-rider assignment and set the
-- restored one back to 'released'. This ensures the volunteer (last person
-- who had the drive) can re-accept, not the original driver.
--
-- Only matches the broken pattern — won't touch assignments where both
-- have riders or both have 0 riders.

do $$
declare
  r record;
  v_fixed integer := 0;
begin
  for r in
    select da_with_riders.id as with_riders_id,
           da_no_riders.id as no_riders_id,
           da_with_riders.trip_id,
           da_with_riders.schedule_version_id,
           da_with_riders.group_id,
           da_with_riders.driver_profile_id as with_riders_driver
    from public.driver_assignments da_with_riders
    join public.driver_assignments da_no_riders
      on da_no_riders.schedule_version_id = da_with_riders.schedule_version_id
     and da_no_riders.trip_id = da_with_riders.trip_id
     and da_no_riders.driver_profile_id <> da_with_riders.driver_profile_id
    where da_with_riders.status = 'declined'
      and da_no_riders.status = 'declined'
      and (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = da_with_riders.id) > 0
      and (select count(*) from public.rider_assignments ra where ra.driver_assignment_id = da_no_riders.id) = 0
      -- Only fix pairs where the with_riders assignment was restored from
      -- 'released' by PR #93 (has a released_assignment_restored audit event)
      and exists (
        select 1 from public.audit_events ae
        where ae.entity_id = da_with_riders.id::text
          and ae.action = 'released_assignment_restored'
      )
  loop
    -- Move riders to the 0-rider assignment
    update public.rider_assignments
    set driver_assignment_id = r.no_riders_id
    where driver_assignment_id = r.with_riders_id;

    -- Set the restored assignment back to 'released'
    update public.driver_assignments
    set status = 'released'
    where id = r.with_riders_id;

    -- Audit
    insert into public.audit_events (
      group_id, actor_profile_id, action, entity_type, entity_id, details
    )
    values (
      r.group_id,
      r.with_riders_driver,
      'released_assignment_reverted', 'driver_assignment',
      r.with_riders_id::text,
      jsonb_build_object(
        'reverted_assignment_id', r.with_riders_id,
        'riders_moved_to', r.no_riders_id,
        'trip_id', r.trip_id,
        'reason', 'undo PR #93 restore: riders stay with volunteer'
      )
    );

    v_fixed := v_fixed + 1;
  end loop;

  raise notice 'Fixed % assignment pair(s)', v_fixed;
end $$;