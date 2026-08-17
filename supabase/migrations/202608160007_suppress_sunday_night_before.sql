-- Suppress the Sunday night-before summary.
--
-- The night-before summary fires at 7:45 PM Pacific (45 2,3 * * 0-4).
-- On Sundays, the schedule isn't published yet (publish is now at 8:45 PM
-- per 202608160006), so the Sunday fire is a no-op (no published version
-- found). The 8:45 PM "published" email already covers the full week
-- including Monday, so the Sunday night-before is redundant.
--
-- Change: 45 2,3 * * 0-4  (Sun–Thu)  →  45 2,3 * * 1-4  (Mon–Thu only)
--
-- Mon–Thu night-before still fires normally: it finds the published version
-- (published Sunday at 8:45 PM) and sends tomorrow's roster to riding
-- families. No Sunday gap — the "published" email at 8:45 PM covers Monday.
--
-- Idempotent: unschedule uses exception guard, schedule replaces by jobname.

do $$
begin
  perform cron.unschedule('night-before-summary');
exception when others then null;
end $$;

select cron.schedule(
  'night-before-summary',
  '45 2,3 * * 1-4',
  $$ select public.send_night_before_summary(); $$
);