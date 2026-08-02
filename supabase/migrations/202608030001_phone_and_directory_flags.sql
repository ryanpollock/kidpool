-- Parent directory: phone number + opt-out sharing flags.
-- Phone is collected at onboarding (required) and editable in account screen.
-- share_phone / share_email default true (opt-out) so the parent directory
-- is populated by default; parents can toggle off.

alter table public.profiles
  add column if not exists phone text,
  add column if not exists share_phone boolean not null default true,
  add column if not exists share_email boolean not null default true;