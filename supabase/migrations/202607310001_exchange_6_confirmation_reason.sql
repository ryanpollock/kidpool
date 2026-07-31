begin;

alter table public.driver_confirmations
  add column if not exists decline_reason text
  check (decline_reason is null or char_length(decline_reason) <= 500);

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

  if assignment.status <> 'tentative' then
    raise exception 'This assignment is no longer awaiting confirmation';
  end if;

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
  );

  update public.driver_assignments
  set status = case
    when driver_response = 'confirmed' then 'confirmed'::public.assignment_status
    else 'declined'::public.assignment_status
  end
  where id = assignment.id
  returning * into assignment;

  insert into public.audit_events (
    group_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    details
  )
  values (
    assignment.group_id,
    auth.uid(),
    'driver_assignment_responded',
    'driver_assignment',
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

revoke all on function public.respond_to_driver_assignment(uuid, public.confirmation_response) from public;

commit;