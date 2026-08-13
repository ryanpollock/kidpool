-- Repeatable development seed. Parent accounts and household records are
-- created through Google sign-in and onboarding rather than by bypassing Auth.

-- In Supabase cloud, anon/service_role grants are auto-applied by the platform.
-- Locally they must be explicit. Idempotent — GRANT is a no-op if already granted.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

insert into public.groups (
  id,
  name,
  slug,
  timezone,
  meeting_point,
  school_name
)
values (
  'c1000000-0000-4000-8000-000000000001',
  'Midtown Terrace–Presidio Carpool',
  'midtown-presidio',
  'America/Los_Angeles',
  'Midtown Terrace Playground',
  'Presidio Middle School'
)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  timezone = excluded.timezone,
  meeting_point = excluded.meeting_point,
  school_name = excluded.school_name;
