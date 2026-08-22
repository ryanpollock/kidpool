-- Schedule the "New: 4:20 PM afternoon pickup option" broadcast email to all
-- active pilot families. Fires once at 8:45 AM Pacific (15:45 UTC) on Aug 22, 2026.
-- The function self-unschedules after firing so it cannot recur.
--
-- Uses cron_edge_base_url and cron_secret from vault — same pattern as
-- send_drive_reminders() and other pg_cron trigger functions.

create or replace function public.send_afternoon_feature_announcement()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_base_url text;
  v_html_body text;
  v_text_body text;
  v_resp jsonb;
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

  v_html_body := '<h1 style="font-size:22px;margin:0 0 16px;">New afternoon pickup option</h1>' ||
    '<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">We have added a 4:20 PM afternoon pickup alongside the existing 5:15 PM. Families can now choose between two afternoon drive times &mdash; or select &ldquo;Either is fine&rdquo; and let the scheduler assign their child to whichever trip has room.</p>' ||
    '<h2 style="font-size:16px;margin:24px 0 8px;">What is new</h2>' ||
    '<ul style="font-size:15px;line-height:1.6;margin:0 0 8px;padding-left:20px;">' ||
    '<li>Two afternoon options: 4:20 PM and 5:15 PM pickup from Presidio</li>' ||
    '<li>&ldquo;Either is fine&rdquo;: If both times work, the scheduler tries 4:20 first and falls back to 5:15 if that trip is full</li>' ||
    '<li>Independent driving preferences: Parents can volunteer to drive 4:20, 5:15, or both &mdash; separately</li>' ||
    '<li>Standard week defaults: The Account screen now has 3 columns (AM, 4:20 PM, 5:15 PM) for setting recurring defaults</li>' ||
    '</ul>' ||
    '<h2 style="font-size:16px;margin:24px 0 8px;">What stays the same</h2>' ||
    '<ul style="font-size:15px;line-height:1.6;margin:0 0 8px;padding-left:20px;">' ||
    '<li>Morning pickup is unchanged (8:40 AM from Midtown Terrace)</li>' ||
    '<li>Existing weeks keep their 2 trips/day &mdash; no change to live schedules</li>' ||
    '<li>New weeks created from now on will have 3 trips/day</li>' ||
    '<li>Your existing standard-week defaults carry over (set to 5:15 PM) until you edit them</li>' ||
    '</ul>' ||
    '<h2 style="font-size:16px;margin:24px 0 8px;">What to do</h2>' ||
    '<ul style="font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:20px;">' ||
    '<li>Open the app and go to <strong>Account &rarr; Standard Week</strong></li>' ||
    '<li>Review your family afternoon preferences &mdash; update to 4:20, 5:15, or &ldquo;Either&rdquo; for each day</li>' ||
    '<li>Update your driving availability for the 4:20 PM slot if you can drive it</li>' ||
    '<li>When you check in for next week, you will see the new time picker for afternoons</li>' ||
    '</ul>';

  v_text_body := 'New: 4:20 PM afternoon pickup option' || E'\n\n' ||
    'New afternoon pickup option' || E'\n\n' ||
    'We have added a 4:20 PM afternoon pickup alongside the existing 5:15 PM. Families can now choose between two afternoon drive times — or select "Either is fine" and let the scheduler assign their child to whichever trip has room.' || E'\n\n' ||
    'WHAT IS NEW' || E'\n\n' ||
    '- Two afternoon options: 4:20 PM and 5:15 PM pickup from Presidio' || E'\n' ||
    '- "Either is fine": If both times work, the scheduler tries 4:20 first and falls back to 5:15 if that trip is full' || E'\n' ||
    '- Independent driving preferences: Parents can volunteer to drive 4:20, 5:15, or both — separately' || E'\n' ||
    '- Standard week defaults: The Account screen now has 3 columns (AM, 4:20 PM, 5:15 PM) for setting recurring defaults' || E'\n\n' ||
    'WHAT STAYS THE SAME' || E'\n\n' ||
    '- Morning pickup is unchanged (8:40 AM from Midtown Terrace)' || E'\n' ||
    '- Existing weeks keep their 2 trips/day — no change to live schedules' || E'\n' ||
    '- New weeks created from now on will have 3 trips/day' || E'\n' ||
    '- Your existing standard-week defaults carry over (set to 5:15 PM) until you edit them' || E'\n\n' ||
    'WHAT TO DO' || E'\n\n' ||
    '- Open the app and go to Account -> Standard Week' || E'\n' ||
    '- Review your family afternoon preferences — update to 4:20, 5:15, or "Either" for each day' || E'\n' ||
    '- Update your driving availability for the 4:20 PM slot if you can drive it' || E'\n' ||
    '- When you check in for next week, you will see the new time picker for afternoons';

  perform net.http_post(
    url := v_base_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'type', 'broadcast',
      'broadcast_id', 'afternoon-feature-2026-08-22',
      'subject', 'New: 4:20 PM afternoon pickup option',
      'html_body', v_html_body,
      'text_body', v_text_body
    )
  );

  -- Self-unschedule so this fires only once
  perform cron.unschedule('afternoon-feature-announcement');
end;
$$;

revoke all on function public.send_afternoon_feature_announcement() from public, authenticated;

-- Fire once at 15:45 UTC on Aug 22, 2026 (= 8:45 AM PDT)
select cron.schedule(
  'afternoon-feature-announcement',
  '45 15 22 8 *',
  $$ select public.send_afternoon_feature_announcement(); $$
);