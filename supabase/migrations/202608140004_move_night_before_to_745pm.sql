-- Move the night-before summary from hourly (self-gating to 9-10 PM Pacific)
-- to a fixed 7:45 PM Pacific cron, Sun-Thu nights (nights before Mon-Fri
-- school days).
--
-- 7:45 PM gives parents time to adjust if there's a gap in the schedule,
-- instead of learning about it right before bed at 9 PM.
--
-- DST-proofed via dual UTC schedules:
--   7:45 PM PDT = 02:45 UTC  → 45 2,3 * * 0-4
--   7:45 PM PST = 03:45 UTC  → (same cron, off-DST fire deduped)
--
-- The off-DST fire is deduped by the existing per-recipient idempotency key
-- (night-before-${tomorrow}-${profile.id}) for email, and the push tag
-- (night-before-${tomorrow}-${profile.id}) replaces if still visible.
--
-- Sunday gap: on Sunday night the schedule isn't published yet (auto-publish
-- fires at 8:30 PM). The night-before at 7:45 PM finds no published version
-- and no-ops. The "Schedule published" notification at 8:30 PM serves as
-- Monday's heads-up. Mon-Wed nights work normally (schedule published the
-- prior Sunday).
--
-- The existing send_night_before_summary() wrapper function already has
-- the 120s pg_net timeout from 202608130002. No function changes needed —
-- just the cron schedule.

do $$
begin
  perform cron.unschedule('night-before-summary');
exception when others then null;
end $$;

select cron.schedule(
  'night-before-summary',
  '45 2,3 * * 0-4',
  $$ select public.send_night_before_summary(); $$
);