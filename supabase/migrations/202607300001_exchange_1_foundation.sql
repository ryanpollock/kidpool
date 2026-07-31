begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum ('member', 'coordinator');
create type public.membership_status as enum ('active', 'suspended', 'removed');
create type public.week_status as enum ('open', 'draft', 'confirming', 'published', 'closed');
create type public.trip_direction as enum ('morning', 'afternoon');
create type public.trip_status as enum ('scheduled', 'covered', 'uncovered', 'canceled');
create type public.checkin_status as enum ('draft', 'submitted');
create type public.drive_preference as enum ('prefer', 'can', 'cannot');
create type public.schedule_status as enum ('draft', 'published', 'superseded');
create type public.assignment_status as enum ('tentative', 'confirmed', 'declined', 'expired', 'released');
create type public.confirmation_response as enum ('confirmed', 'declined');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null check (char_length(trim(full_name)) between 2 and 120),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_lower_idx on public.profiles (lower(email));

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  timezone text not null default 'America/Los_Angeles',
  meeting_point text not null,
  school_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.households (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, group_id)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  household_id uuid not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null default 'member',
  status public.membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, group_id)
    references public.households(id, group_id) on delete cascade,
  unique (group_id, profile_id)
);

create index memberships_household_idx on public.memberships (household_id);
create index memberships_profile_idx on public.memberships (profile_id);

create table public.household_join_codes (
  household_id uuid primary key references public.households(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  foreign key (household_id, group_id)
    references public.households(id, group_id) on delete cascade,
  unique (group_id, code_hash)
);

create table public.children (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  household_id uuid not null,
  first_name text not null check (char_length(trim(first_name)) between 1 and 80),
  last_name text not null check (char_length(trim(last_name)) between 1 and 80),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, group_id)
    references public.households(id, group_id) on delete cascade,
  unique (id, group_id)
);

create index children_household_idx on public.children (household_id);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  household_id uuid not null,
  default_driver_id uuid references public.profiles(id) on delete set null,
  label text not null check (char_length(trim(label)) between 2 and 80),
  child_passenger_capacity integer not null
    check (child_passenger_capacity between 1 and 12),
  notes text check (notes is null or char_length(notes) <= 500),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, group_id)
    references public.households(id, group_id) on delete cascade,
  unique (id, group_id)
);

create index vehicles_household_idx on public.vehicles (household_id);

create table public.weeks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  starts_on date not null check (extract(isodow from starts_on) = 1),
  status public.week_status not null default 'open',
  checkin_deadline timestamptz,
  confirmation_deadline timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, starts_on),
  unique (id, group_id)
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  week_id uuid not null,
  service_date date not null,
  direction public.trip_direction not null,
  meeting_time time not null,
  departure_time time not null,
  origin text not null,
  destination text not null,
  status public.trip_status not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (week_id, group_id)
    references public.weeks(id, group_id) on delete cascade,
  unique (week_id, service_date, direction),
  unique (id, group_id)
);

create index trips_group_date_idx on public.trips (group_id, service_date, direction);

create table public.weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  week_id uuid not null,
  household_id uuid not null,
  status public.checkin_status not null default 'draft',
  max_drives integer not null default 0 check (max_drives between 0 and 10),
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (week_id, group_id)
    references public.weeks(id, group_id) on delete cascade,
  foreign key (household_id, group_id)
    references public.households(id, group_id) on delete cascade,
  unique (week_id, household_id),
  unique (id, group_id)
);

create table public.ride_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  checkin_id uuid not null,
  trip_id uuid not null,
  child_id uuid not null,
  needs_ride boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (checkin_id, group_id)
    references public.weekly_checkins(id, group_id) on delete cascade,
  foreign key (trip_id, group_id)
    references public.trips(id, group_id) on delete cascade,
  foreign key (child_id, group_id)
    references public.children(id, group_id) on delete cascade,
  unique (trip_id, child_id)
);

create index ride_requests_checkin_idx on public.ride_requests (checkin_id);
create index ride_requests_trip_needed_idx on public.ride_requests (trip_id, needs_ride);

create table public.driver_availability (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  checkin_id uuid not null,
  trip_id uuid not null,
  driver_profile_id uuid not null references public.profiles(id) on delete cascade,
  vehicle_id uuid,
  preference public.drive_preference not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (checkin_id, group_id)
    references public.weekly_checkins(id, group_id) on delete cascade,
  foreign key (trip_id, group_id)
    references public.trips(id, group_id) on delete cascade,
  foreign key (vehicle_id, group_id)
    references public.vehicles(id, group_id) on delete restrict,
  check (
    (preference = 'cannot' and vehicle_id is null)
    or (preference in ('prefer', 'can') and vehicle_id is not null)
  ),
  unique (trip_id, driver_profile_id)
);

create index driver_availability_checkin_idx on public.driver_availability (checkin_id);
create index driver_availability_trip_idx on public.driver_availability (trip_id, preference);

create table public.schedule_versions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  week_id uuid not null,
  version_number integer not null check (version_number > 0),
  status public.schedule_status not null default 'draft',
  algorithm_version text not null default 'manual-v1',
  change_summary text,
  generated_by uuid references public.profiles(id),
  generated_at timestamptz not null default now(),
  published_at timestamptz,
  foreign key (week_id, group_id)
    references public.weeks(id, group_id) on delete cascade,
  unique (week_id, version_number),
  unique (id, group_id)
);

create unique index one_published_schedule_per_week_idx
  on public.schedule_versions (week_id)
  where status = 'published';

create table public.driver_assignments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  schedule_version_id uuid not null,
  trip_id uuid not null,
  driver_profile_id uuid not null references public.profiles(id) on delete restrict,
  vehicle_id uuid not null,
  status public.assignment_status not null default 'tentative',
  child_passenger_capacity integer not null
    check (child_passenger_capacity between 1 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (schedule_version_id, group_id)
    references public.schedule_versions(id, group_id) on delete cascade,
  foreign key (trip_id, group_id)
    references public.trips(id, group_id) on delete cascade,
  foreign key (vehicle_id, group_id)
    references public.vehicles(id, group_id) on delete restrict,
  unique (schedule_version_id, trip_id, driver_profile_id),
  unique (id, group_id)
);

create index driver_assignments_trip_idx
  on public.driver_assignments (trip_id, status);
create index driver_assignments_driver_idx
  on public.driver_assignments (driver_profile_id, status);

create table public.rider_assignments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  schedule_version_id uuid not null,
  trip_id uuid not null,
  driver_assignment_id uuid not null,
  child_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (schedule_version_id, group_id)
    references public.schedule_versions(id, group_id) on delete cascade,
  foreign key (trip_id, group_id)
    references public.trips(id, group_id) on delete cascade,
  foreign key (driver_assignment_id, group_id)
    references public.driver_assignments(id, group_id) on delete cascade,
  foreign key (child_id, group_id)
    references public.children(id, group_id) on delete restrict,
  unique (schedule_version_id, trip_id, child_id)
);

create index rider_assignments_driver_idx
  on public.rider_assignments (driver_assignment_id);

create table public.driver_confirmations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  driver_assignment_id uuid not null,
  driver_profile_id uuid not null references public.profiles(id) on delete restrict,
  response public.confirmation_response not null,
  responded_at timestamptz not null default now(),
  foreign key (driver_assignment_id, group_id)
    references public.driver_assignments(id, group_id) on delete cascade,
  unique (driver_assignment_id)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.groups(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action text not null check (char_length(trim(action)) between 2 and 100),
  entity_type text not null check (char_length(trim(entity_type)) between 2 and 80),
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index audit_events_group_time_idx
  on public.audit_events (group_id, occurred_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();
create trigger groups_set_updated_at
before update on public.groups
for each row execute function public.set_updated_at();
create trigger households_set_updated_at
before update on public.households
for each row execute function public.set_updated_at();
create trigger memberships_set_updated_at
before update on public.memberships
for each row execute function public.set_updated_at();
create trigger children_set_updated_at
before update on public.children
for each row execute function public.set_updated_at();
create trigger vehicles_set_updated_at
before update on public.vehicles
for each row execute function public.set_updated_at();
create trigger weeks_set_updated_at
before update on public.weeks
for each row execute function public.set_updated_at();
create trigger trips_set_updated_at
before update on public.trips
for each row execute function public.set_updated_at();
create trigger weekly_checkins_set_updated_at
before update on public.weekly_checkins
for each row execute function public.set_updated_at();
create trigger ride_requests_set_updated_at
before update on public.ride_requests
for each row execute function public.set_updated_at();
create trigger driver_availability_set_updated_at
before update on public.driver_availability
for each row execute function public.set_updated_at();
create trigger driver_assignments_set_updated_at
before update on public.driver_assignments
for each row execute function public.set_updated_at();

create or replace function public.validate_trip_service_date()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  week_start date;
begin
  select starts_on into week_start
  from public.weeks
  where id = new.week_id and group_id = new.group_id;

  if week_start is null then
    raise exception 'Trip week not found';
  end if;

  if new.service_date < week_start or new.service_date > week_start + 6 then
    raise exception 'Trip date must fall within its week';
  end if;

  return new;
end;
$$;

create trigger trips_validate_service_date
before insert or update of week_id, group_id, service_date on public.trips
for each row execute function public.validate_trip_service_date();

create or replace function public.validate_ride_request_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  checkin_household_id uuid;
  child_household_id uuid;
  checkin_week_id uuid;
  trip_week_id uuid;
begin
  select household_id, week_id
  into checkin_household_id, checkin_week_id
  from public.weekly_checkins
  where id = new.checkin_id and group_id = new.group_id;

  select household_id
  into child_household_id
  from public.children
  where id = new.child_id and group_id = new.group_id;

  select week_id
  into trip_week_id
  from public.trips
  where id = new.trip_id and group_id = new.group_id;

  if checkin_household_id is null
    or child_household_id is null
    or trip_week_id is null then
    raise exception 'Ride request references missing records';
  end if;

  if checkin_household_id <> child_household_id then
    raise exception 'A household can request rides only for its own children';
  end if;

  if checkin_week_id <> trip_week_id then
    raise exception 'Ride request trip must belong to the check-in week';
  end if;

  return new;
end;
$$;

create trigger ride_requests_validate_scope
before insert or update of group_id, checkin_id, trip_id, child_id
on public.ride_requests
for each row execute function public.validate_ride_request_scope();

create or replace function public.validate_driver_availability_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  checkin_household_id uuid;
  checkin_week_id uuid;
  driver_household_id uuid;
  vehicle_household_id uuid;
  trip_week_id uuid;
begin
  select household_id, week_id
  into checkin_household_id, checkin_week_id
  from public.weekly_checkins
  where id = new.checkin_id and group_id = new.group_id;

  select household_id
  into driver_household_id
  from public.memberships
  where group_id = new.group_id
    and profile_id = new.driver_profile_id
    and status = 'active';

  select week_id
  into trip_week_id
  from public.trips
  where id = new.trip_id and group_id = new.group_id;

  if new.vehicle_id is not null then
    select household_id
    into vehicle_household_id
    from public.vehicles
    where id = new.vehicle_id
      and group_id = new.group_id
      and active;
  else
    vehicle_household_id := checkin_household_id;
  end if;

  if checkin_household_id is null
    or driver_household_id is null
    or vehicle_household_id is null
    or trip_week_id is null then
    raise exception 'Driver availability references missing or inactive records';
  end if;

  if checkin_household_id <> driver_household_id
    or checkin_household_id <> vehicle_household_id then
    raise exception 'Driver, check-in, and vehicle must belong to one household';
  end if;

  if checkin_week_id <> trip_week_id then
    raise exception 'Availability trip must belong to the check-in week';
  end if;

  return new;
end;
$$;

create trigger driver_availability_validate_scope
before insert or update of group_id, checkin_id, trip_id, driver_profile_id, vehicle_id
on public.driver_availability
for each row execute function public.validate_driver_availability_scope();

create or replace function public.validate_driver_assignment_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  schedule_week_id uuid;
  trip_week_id uuid;
  driver_household_id uuid;
  vehicle_household_id uuid;
begin
  select week_id
  into schedule_week_id
  from public.schedule_versions
  where id = new.schedule_version_id and group_id = new.group_id;

  select week_id
  into trip_week_id
  from public.trips
  where id = new.trip_id and group_id = new.group_id;

  select household_id
  into driver_household_id
  from public.memberships
  where group_id = new.group_id
    and profile_id = new.driver_profile_id
    and status = 'active';

  select household_id
  into vehicle_household_id
  from public.vehicles
  where id = new.vehicle_id
    and group_id = new.group_id
    and active;

  if schedule_week_id is null
    or trip_week_id is null
    or driver_household_id is null
    or vehicle_household_id is null then
    raise exception 'Driver assignment references missing or inactive records';
  end if;

  if schedule_week_id <> trip_week_id then
    raise exception 'Driver assignment trip must belong to the schedule week';
  end if;

  if driver_household_id <> vehicle_household_id then
    raise exception 'Driver and vehicle must belong to one household';
  end if;

  return new;
end;
$$;

create trigger driver_assignments_validate_scope
before insert or update of group_id, schedule_version_id, trip_id, driver_profile_id, vehicle_id
on public.driver_assignments
for each row execute function public.validate_driver_assignment_scope();

create or replace function public.enforce_rider_assignment_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  assignment_capacity integer;
  assigned_count integer;
  assignment_group_id uuid;
  assignment_trip_id uuid;
  assignment_schedule_version_id uuid;
begin
  select
    child_passenger_capacity,
    group_id,
    trip_id,
    schedule_version_id
  into
    assignment_capacity,
    assignment_group_id,
    assignment_trip_id,
    assignment_schedule_version_id
  from public.driver_assignments
  where id = new.driver_assignment_id;

  if assignment_capacity is null then
    raise exception 'Driver assignment not found';
  end if;

  if assignment_group_id <> new.group_id
    or assignment_trip_id <> new.trip_id
    or assignment_schedule_version_id <> new.schedule_version_id then
    raise exception 'Rider assignment does not match its driver assignment';
  end if;

  select count(*)
  into assigned_count
  from public.rider_assignments
  where driver_assignment_id = new.driver_assignment_id
    and id <> new.id;

  if assigned_count >= assignment_capacity then
    raise exception 'Vehicle child-passenger capacity exceeded';
  end if;

  return new;
end;
$$;

create trigger rider_assignments_enforce_capacity
before insert or update of driver_assignment_id, child_id
on public.rider_assignments
for each row execute function public.enforce_rider_assignment_capacity();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(coalesce(new.email, 'New parent'), '@', 1)
    ),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_group_member(target_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships
    where group_id = target_group_id
      and profile_id = auth.uid()
      and status = 'active'
  );
$$;

create or replace function public.is_group_coordinator(target_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships
    where group_id = target_group_id
      and profile_id = auth.uid()
      and status = 'active'
      and role = 'coordinator'
  );
$$;

create or replace function public.is_household_member(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships
    where household_id = target_household_id
      and profile_id = auth.uid()
      and status = 'active'
  );
$$;

create or replace function public.shares_group_with_profile(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.group_id = mine.group_id
    where mine.profile_id = auth.uid()
      and mine.status = 'active'
      and theirs.profile_id = target_profile_id
      and theirs.status = 'active'
  );
$$;

revoke all on function public.is_group_member(uuid) from public;
revoke all on function public.is_group_coordinator(uuid) from public;
revoke all on function public.is_household_member(uuid) from public;
revoke all on function public.shares_group_with_profile(uuid) from public;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_coordinator(uuid) to authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.shares_group_with_profile(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.households enable row level security;
alter table public.memberships enable row level security;
alter table public.household_join_codes enable row level security;
alter table public.children enable row level security;
alter table public.vehicles enable row level security;
alter table public.weeks enable row level security;
alter table public.trips enable row level security;
alter table public.weekly_checkins enable row level security;
alter table public.ride_requests enable row level security;
alter table public.driver_availability enable row level security;
alter table public.schedule_versions enable row level security;
alter table public.driver_assignments enable row level security;
alter table public.rider_assignments enable row level security;
alter table public.driver_confirmations enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_select_group
on public.profiles for select to authenticated
using (id = auth.uid() or public.shares_group_with_profile(id));
create policy profiles_update_self
on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

create policy groups_select_authenticated
on public.groups for select to authenticated
using (true);
create policy groups_update_coordinator
on public.groups for update to authenticated
using (public.is_group_coordinator(id))
with check (public.is_group_coordinator(id));

create policy households_select_group
on public.households for select to authenticated
using (public.is_group_member(group_id));
create policy households_update_owner_or_coordinator
on public.households for update to authenticated
using (
  public.is_household_member(id)
  or public.is_group_coordinator(group_id)
)
with check (
  public.is_household_member(id)
  or public.is_group_coordinator(group_id)
);

create policy memberships_select_group_or_self
on public.memberships for select to authenticated
using (profile_id = auth.uid() or public.is_group_member(group_id));
create policy memberships_update_coordinator
on public.memberships for update to authenticated
using (public.is_group_coordinator(group_id))
with check (public.is_group_coordinator(group_id));

create policy join_codes_select_household
on public.household_join_codes for select to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);
create policy join_codes_manage_household
on public.household_join_codes for all to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
)
with check (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);

create policy children_select_group
on public.children for select to authenticated
using (public.is_group_member(group_id));
create policy children_insert_household
on public.children for insert to authenticated
with check (
  created_by = auth.uid()
  and (
    public.is_household_member(household_id)
    or public.is_group_coordinator(group_id)
  )
);
create policy children_update_household
on public.children for update to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
)
with check (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);
create policy children_delete_household
on public.children for delete to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);

create policy vehicles_select_group
on public.vehicles for select to authenticated
using (public.is_group_member(group_id));
create policy vehicles_insert_household
on public.vehicles for insert to authenticated
with check (
  created_by = auth.uid()
  and (
    public.is_household_member(household_id)
    or public.is_group_coordinator(group_id)
  )
);
create policy vehicles_update_household
on public.vehicles for update to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
)
with check (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);
create policy vehicles_delete_household
on public.vehicles for delete to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);

create policy weeks_select_group
on public.weeks for select to authenticated
using (public.is_group_member(group_id));
create policy weeks_manage_coordinator
on public.weeks for all to authenticated
using (public.is_group_coordinator(group_id))
with check (public.is_group_coordinator(group_id));

create policy trips_select_group
on public.trips for select to authenticated
using (public.is_group_member(group_id));
create policy trips_manage_coordinator
on public.trips for all to authenticated
using (public.is_group_coordinator(group_id))
with check (public.is_group_coordinator(group_id));

create policy checkins_select_group
on public.weekly_checkins for select to authenticated
using (public.is_group_member(group_id));
create policy checkins_insert_household
on public.weekly_checkins for insert to authenticated
with check (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);
create policy checkins_update_household
on public.weekly_checkins for update to authenticated
using (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
)
with check (
  public.is_household_member(household_id)
  or public.is_group_coordinator(group_id)
);

create policy ride_requests_select_group
on public.ride_requests for select to authenticated
using (public.is_group_member(group_id));
create policy ride_requests_manage_household
on public.ride_requests for all to authenticated
using (
  exists (
    select 1
    from public.weekly_checkins checkin
    where checkin.id = checkin_id
      and public.is_household_member(checkin.household_id)
  )
  or public.is_group_coordinator(group_id)
)
with check (
  created_by = auth.uid()
  and (
    exists (
      select 1
      from public.weekly_checkins checkin
      where checkin.id = checkin_id
        and public.is_household_member(checkin.household_id)
    )
    or public.is_group_coordinator(group_id)
  )
);

create policy availability_select_group
on public.driver_availability for select to authenticated
using (public.is_group_member(group_id));
create policy availability_manage_driver
on public.driver_availability for all to authenticated
using (
  driver_profile_id = auth.uid()
  or public.is_group_coordinator(group_id)
)
with check (
  driver_profile_id = auth.uid()
  or public.is_group_coordinator(group_id)
);

create policy schedule_versions_select_group
on public.schedule_versions for select to authenticated
using (public.is_group_member(group_id));
create policy schedule_versions_manage_coordinator
on public.schedule_versions for all to authenticated
using (public.is_group_coordinator(group_id))
with check (public.is_group_coordinator(group_id));

create policy driver_assignments_select_group
on public.driver_assignments for select to authenticated
using (public.is_group_member(group_id));
create policy driver_assignments_manage_coordinator
on public.driver_assignments for all to authenticated
using (public.is_group_coordinator(group_id))
with check (public.is_group_coordinator(group_id));

create policy rider_assignments_select_group
on public.rider_assignments for select to authenticated
using (public.is_group_member(group_id));
create policy rider_assignments_manage_coordinator
on public.rider_assignments for all to authenticated
using (public.is_group_coordinator(group_id))
with check (public.is_group_coordinator(group_id));

create policy confirmations_select_group
on public.driver_confirmations for select to authenticated
using (public.is_group_member(group_id));
create policy audit_events_select_group
on public.audit_events for select to authenticated
using (public.is_group_member(group_id));
create policy audit_events_insert_member
on public.audit_events for insert to authenticated
with check (
  actor_profile_id = auth.uid()
  and public.is_group_member(group_id)
);

create or replace function public.create_household_with_membership(
  target_group_id uuid,
  household_name text
)
returns table (household_id uuid, join_code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  created_household_id uuid;
  raw_join_code text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Profile is not ready';
  end if;

  if not exists (select 1 from public.groups where id = target_group_id) then
    raise exception 'Carpool group not found';
  end if;

  if exists (
    select 1 from public.memberships
    where group_id = target_group_id
      and profile_id = auth.uid()
      and status <> 'removed'
  ) then
    raise exception 'This account already belongs to a household';
  end if;

  insert into public.households (group_id, name, created_by)
  values (target_group_id, trim(household_name), auth.uid())
  returning id into created_household_id;

  insert into public.memberships (group_id, household_id, profile_id)
  values (target_group_id, created_household_id, auth.uid());

  raw_join_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));

  insert into public.household_join_codes (
    household_id,
    group_id,
    code_hash,
    created_by
  )
  values (
    created_household_id,
    target_group_id,
    encode(digest(raw_join_code, 'sha256'), 'hex'),
    auth.uid()
  );

  return query select created_household_id, raw_join_code;
end;
$$;

create or replace function public.join_household_by_code(
  target_group_id uuid,
  supplied_join_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_household_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Profile is not ready';
  end if;

  if exists (
    select 1 from public.memberships
    where group_id = target_group_id
      and profile_id = auth.uid()
      and status <> 'removed'
  ) then
    raise exception 'This account already belongs to a household';
  end if;

  select household_id
  into target_household_id
  from public.household_join_codes
  where group_id = target_group_id
    and code_hash = encode(digest(upper(trim(supplied_join_code)), 'sha256'), 'hex')
    and (expires_at is null or expires_at > now());

  if target_household_id is null then
    raise exception 'Household code is invalid or expired';
  end if;

  insert into public.memberships (group_id, household_id, profile_id)
  values (target_group_id, target_household_id, auth.uid());

  return target_household_id;
end;
$$;

create or replace function public.respond_to_driver_assignment(
  target_assignment_id uuid,
  driver_response public.confirmation_response
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
    response
  )
  values (
    assignment.group_id,
    assignment.id,
    auth.uid(),
    driver_response
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
    jsonb_build_object('response', driver_response)
  );

  return assignment;
end;
$$;

revoke all on function public.create_household_with_membership(uuid, text) from public;
revoke all on function public.join_household_by_code(uuid, text) from public;
revoke all on function public.respond_to_driver_assignment(uuid, public.confirmation_response) from public;
grant execute on function public.create_household_with_membership(uuid, text) to authenticated;
grant execute on function public.join_household_by_code(uuid, text) to authenticated;
grant execute on function public.respond_to_driver_assignment(uuid, public.confirmation_response) to authenticated;

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

commit;
