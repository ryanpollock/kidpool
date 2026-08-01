-- Push subscriptions for PWA web push notifications.
-- Each user can have multiple subscriptions (e.g., phone + desktop).

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  endpoint text not null,
  p256dh_key text not null,
  auth_key text not null,
  created_at timestamptz not null default now(),
  unique (profile_id, endpoint)
);

alter table public.push_subscriptions enable row level security;

create policy push_subscriptions_self
  on public.push_subscriptions for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());