-- Add hourly cron for confirmation deadline reminders.
-- Same pattern as checkin-deadline-reminder: fires hourly, the send-push
-- confirmation_reminder type self-gates to weeks where the confirmation
-- deadline is within 24 hours, and targets only drivers with tentative
-- assignments.

create or replace function public.send_confirmation_reminders()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'No cron_secret found in vault';
    return;
  end if;

  select decrypted_secret into v_base_url
  from vault.decrypted_secrets
  where name = 'cron_edge_base_url'
  limit 1;

  if v_base_url is null then
    raise notice 'No cron_edge_base_url found in vault';
    return;
  end if;

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('type', 'confirmation_reminder')
  );
end;
$$;

revoke all on function public.send_confirmation_reminders() from public, authenticated;

select cron.schedule(
  'confirmation-deadline-reminder',
  '0 * * * *',
  $$ select public.send_confirmation_reminders(); $$
);