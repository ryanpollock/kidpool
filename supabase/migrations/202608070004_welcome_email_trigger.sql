-- Welcome email: send a one-time onboarding email to new parents when they
-- sign in with Google for the first time. The email explains the household
-- concept, the three tabs, the weekly check-in, standard week defaults, and
-- how to install the app for push notifications.
--
-- Trigger: AFTER INSERT on auth.users (fires once per new auth user).
-- Delivery: pg_net.http_post to the send-push Edge Function with type=welcome.
-- Idempotency: the Edge Function uses Idempotency-Key=welcome-<user_id>, so
-- a duplicate trigger fire won't send a second email.
-- Skip-list: @seed.kidpool, @test.kidpool, @e2e.kidpool are skipped in the
-- Edge Function (same as all other notification types).
--
-- Uses cron_edge_base_url and cron_secret from vault — environment-aware,
-- same pattern as generate_schedule_cron and send_deadline_reminders.

create or replace function public.send_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_full_name text;
begin
  -- Only fire on genuine inserts, not updates.
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return new;
  end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets
  where name = 'cron_edge_base_url'
  limit 1;

  if v_base_url is null then
    raise notice 'No cron_edge_base_url found in vault';
    return new;
  end if;

  -- Derive the parent's name the same way handle_new_user does.
  v_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(coalesce(new.email, 'New parent'), '@', 1)
  );

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'welcome',
      'email', new.email,
      'full_name', v_full_name,
      'user_id', new.id
    )
  );

  return new;
end;
$$;

revoke all on function public.send_welcome_email() from public, authenticated;

-- Trigger: AFTER INSERT only (not update). Separate from on_auth_user_created
-- so a failure in the email trigger can't block profile creation.
create trigger on_auth_user_welcome_email
after insert on auth.users
for each row execute function public.send_welcome_email();