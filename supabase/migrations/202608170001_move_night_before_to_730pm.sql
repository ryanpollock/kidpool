-- Move the night-before summary from 7:45 PM Pacific to 7:30 PM Pacific
-- and extend the DOW range from Mon–Thu (1-4) to Sun–Thu (1-5) so Friday
-- morning's "Tomorrow's carpool" email actually sends.
--
-- 7:30 PM PDT = 02:30 UTC  → 30 2,3 * * 1-5
-- 7:30 PM PST = 03:30 UTC  → (same cron, off-DST fire deduped by per-recipient
--   idempotency key night-before-${tomorrow}-${profile.id})
--
-- Two fixes vs the prior schedule (45 2,3 * * 1-4, set by 202608160007):
--
--   1. DOW 1-4 was wrong. pg_cron runs in UTC, so DOW 1-4 = Sun–Wed Pacific
--      nights — Thursday night (Friday morning's email) was never sent.
--      DOW 1-5 = Sun–Thu Pacific, covering all five school mornings
--      (matches backpack-sheet's 1-5 pattern from 202608160003).
--
--   2. Time 7:45 PM → 7:30 PM. The Sunday auto-publish fires at 7:15 PM
--      Pacific (202608160009). At 7:30 PM the published version is
--      guaranteed committed, so the night-before's "find published
--      version" read can't race the publish's write. Sunday night now
--      sends both the full-week "Schedule published" email (7:15 PM)
--      and the personalized "Tomorrow's carpool" email (7:30 PM) —
--      different content, mild redundancy, acceptable.
--
-- Keeps the wrapper function from 202608070006 (send_night_before_summary).
-- No function changes needed — just the cron schedule.
--
-- Supersedes the 7:45 PM / DOW 1-4 schedule set by 202608160007. Idempotent:
-- unschedule uses exception guard, schedule replaces by jobname.

do $$
begin
  perform cron.unschedule('night-before-summary');
exception when others then null;
end $$;

select cron.schedule(
  'night-before-summary',
  '30 2,3 * * 1-5',
  $$ select public.send_night_before_summary(); $$
);