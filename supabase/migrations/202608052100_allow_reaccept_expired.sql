-- Allow an expired driver to re-accept their drive from the Home screen.
-- Today respond_to_driver_assignment only allows re-response on
-- 'tentative', 'confirmed', or 'declined'. A driver who let the Sunday
-- confirmation deadline pass is 'expired' and has no way back — the
-- coordinator must regenerate. This opens a path back for 'expired'
-- with one guard: if a volunteer has already taken over (rider rows
-- moved away), re-accept is blocked to avoid resurrecting a zero-rider
-- duplicate.
--
-- 'released' stays blocked: another driver has taken over and the old
-- assignment is final.

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