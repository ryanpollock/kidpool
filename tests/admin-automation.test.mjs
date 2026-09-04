import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cronMigrationUrl = new URL(
  "../supabase/migrations/202608070000_schedule_automation.sql",
  import.meta.url,
);
const publishInternalMigrationUrl = new URL(
  "../supabase/migrations/202608070001_publish_schedule_internal.sql",
  import.meta.url,
);
const manualAssignMigrationUrl = new URL(
  "../supabase/migrations/202608070002_manually_assign_driver.sql",
  import.meta.url,
);
const reassignDriverMigrationUrl = new URL(
  "../supabase/migrations/202609030001_reassign_driver.sql",
  import.meta.url,
);
const deadlineCronMigrationUrl = new URL(
  "../supabase/migrations/202608070003_reenable_deadline_cron.sql",
  import.meta.url,
);
const welcomeEmailMigrationUrl = new URL(
  "../supabase/migrations/202608070004_welcome_email_trigger.sql",
  import.meta.url,
);
const volunteerAlreadyDrivingMigrationUrl = new URL(
  "../supabase/migrations/202608070005_volunteer_already_driving.sql",
  import.meta.url,
);
const nightBeforeSummaryMigrationUrl = new URL(
  "../supabase/migrations/202608070006_night_before_summary_cron.sql",
  import.meta.url,
);
const driveReminderMigrationUrl = new URL(
  "../supabase/migrations/202608070007_drive_reminder_cron.sql",
  import.meta.url,
);
const publishSundayEveningMigrationUrl = new URL(
  "../supabase/migrations/202608130005_publish_sunday_evening.sql",
  import.meta.url,
);
const pgnetTimeoutMigrationUrl = new URL(
  "../supabase/migrations/202608130002_increase_pgnet_timeout.sql",
  import.meta.url,
);
const pgnetTimeoutRemainingMigrationUrl = new URL(
  "../supabase/migrations/202608130007_increase_pgnet_timeout_remaining.sql",
  import.meta.url,
);
const fixVolunteerReacceptMigrationUrl = new URL(
  "../supabase/migrations/202608140001_fix_volunteer_reaccept.sql",
  import.meta.url,
);
const allowReleasedReacceptMigrationUrl = new URL(
  "../supabase/migrations/202608140002_allow_released_reaccept.sql",
  import.meta.url,
);
const fixNotificationScheduleMigrationUrl = new URL(
  "../supabase/migrations/202608140003_fix_notification_schedule.sql",
  import.meta.url,
);
const moveNightBeforeMigrationUrl = new URL(
  "../supabase/migrations/202608140004_move_night_before_to_745pm.sql",
  import.meta.url,
);
const coordinatorTentativeSummaryMigrationUrl = new URL(
  "../supabase/migrations/202608160002_coordinator_tentative_summary_cron.sql",
  import.meta.url,
);
const backpackSheetMigrationUrl = new URL(
  "../supabase/migrations/202608160003_backpack_sheet_cron.sql",
  import.meta.url,
);
const backpackSheetTimeoutMigrationUrl = new URL(
  "../supabase/migrations/202608140005_fix_backpack_sheet_timeout.sql",
  import.meta.url,
);
const moveSundayPublishMigrationUrl = new URL(
  "../supabase/migrations/202608160005_move_sunday_publish_to_701pm.sql",
  import.meta.url,
);
const moveSundayPublish845MigrationUrl = new URL(
  "../supabase/migrations/202608160006_move_sunday_publish_to_845pm.sql",
  import.meta.url,
);
const suppressSundayNightBeforeMigrationUrl = new URL(
  "../supabase/migrations/202608160007_suppress_sunday_night_before.sql",
  import.meta.url,
);
const moveSundayPublish930MigrationUrl = new URL(
  "../supabase/migrations/202608160008_move_sunday_publish_to_930pm.sql",
  import.meta.url,
);
const moveSundayPublish715MigrationUrl = new URL(
  "../supabase/migrations/202608160009_move_sunday_publish_to_715pm.sql",
  import.meta.url,
);
const cancelRideByCoordinatorMigrationUrl = new URL(
  "../supabase/migrations/202608160010_cancel_ride_by_coordinator.sql",
  import.meta.url,
);
const moveNightBeforeTo730MigrationUrl = new URL(
  "../supabase/migrations/202608170001_move_night_before_to_730pm.sql",
  import.meta.url,
);
const surgicalSundayCronMigrationUrl = new URL(
  "../supabase/migrations/202608160004_surgical_sunday_evening_cron.sql",
  import.meta.url,
);
const reassignmentMigrationUrl = new URL(
  "../supabase/migrations/202608220002_drive_reassignment.sql",
  import.meta.url,
);
const generateScheduleUrl = new URL(
  "../supabase/functions/generate-schedule/index.ts",
  import.meta.url,
);
const sendPushUrl = new URL(
  "../supabase/functions/send-push/index.ts",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);
const prototypeUrl = new URL(
  "../src/Prototype.tsx",
  import.meta.url,
);

// ─── Schedule automation migration ──────────────────────────

test("schedule automation: creates cron wrapper function and two schedules", async () => {
  const sql = await readFile(cronMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.generate_schedule_cron\(\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.generate_schedule_cron\(\) from public, authenticated/);

  // Saturday cron (after 3 PM Pacific in both DST and standard time)
  assert.match(sql, /generate-schedule-saturday/);
  assert.match(sql, /0 23 \* \* 6/);

  // Sunday cron — originally '0 5 * * 1' here; rescheduled to 8:30 PM Pacific
  // by 202608130005_publish_sunday_evening.sql (tested below). This assertion
  // documents the original schedule; the reschedule test covers the new one.
  assert.match(sql, /generate-schedule-sunday/);
  assert.match(sql, /0 5 \* \* 1/);

  // Uses vault secrets, not hardcoded URLs
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);
  assert.match(sql, /net\.http_post/);
  assert.match(sql, /'source', 'cron'/);

  // Finds next upcoming week per group
  assert.match(sql, /distinct on \(w\.group_id\)/);
  assert.match(sql, /starts_on > \(now\(\) at time zone 'America\/Los_Angeles'\)::date/);
  assert.match(sql, /exists \(select 1 from public\.trips t where t\.week_id = w\.id\)/);
});

// ─── Sunday publish rescheduled to 8:30 PM Pacific ────────────

test("schedule automation: Sunday publish rescheduled to 8:30 PM Pacific", async () => {
  const sql = await readFile(publishSundayEveningMigrationUrl, "utf8");

  // Unschedules the original Sunday cron before re-scheduling it
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);

  // New schedule: '30 3,4 * * 1' = Mon 03:30 and 04:30 UTC (original 8:30 PM
  // Pacific). Later moved to 7:01 PM Pacific by 202608160005 — see the test below.
  assert.match(sql, /30 3,4 \* \* 1/);
  assert.match(sql, /generate_schedule_cron/);

  // Saturday draft cron is NOT touched by this reschedule
  assert.doesNotMatch(sql, /generate-schedule-saturday/);
});

// ─── Sunday publish moved to 7:01 PM Pacific (surgical) ──────

test("schedule automation: Sunday publish moved to 7:01 PM Pacific (surgical)", async () => {
  const sql = await readFile(moveSundayPublishMigrationUrl, "utf8");

  // Unschedules the 8:30 PM Sunday cron before re-scheduling it
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);

  // New schedule: '1 2,3 * * 1' = Mon 02:01 and 03:01 UTC (7:01 PM Pacific,
  // DST-proofed — the off-DST fire is an idempotent no-op once published).
  assert.match(sql, /1 2,3 \* \* 1/);

  // Calls the surgical wrapper (preserves confirmed drives, fits late riders
  // into spare capacity). Does NOT call generate_schedule_cron (full regen),
  // which would reshuffle confirmed drives and regress PR #126.
  assert.match(sql, /publish_and_update_schedule/);
  assert.doesNotMatch(sql, /generate_schedule_cron/);

  // Saturday draft cron is NOT touched by this move
  assert.doesNotMatch(sql, /generate-schedule-saturday/);
});

// ─── Sunday publish moved to 8:45 PM Pacific (final schedule) ──

test("schedule automation: Sunday publish moved to 8:45 PM Pacific", async () => {
  const sql = await readFile(moveSundayPublish845MigrationUrl, "utf8");

  // Unschedules the 7:01 PM Sunday cron before re-scheduling it
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);

  // New schedule: '45 3,4 * * 1' = Mon 03:45 and 04:45 UTC (8:45 PM Pacific,
  // DST-proofed — the off-DST fire is an idempotent no-op once published).
  assert.match(sql, /45 3,4 \* \* 1/);

  // Calls the surgical wrapper (preserves confirmed drives, fits late riders
  // into spare capacity). Does NOT call generate_schedule_cron (full regen),
  // which would reshuffle confirmed drives and regress PR #126.
  assert.match(sql, /publish_and_update_schedule/);
  assert.doesNotMatch(sql, /generate_schedule_cron/);

  // Saturday draft cron is NOT touched by this move
  assert.doesNotMatch(sql, /generate-schedule-saturday/);
});

// ─── Sunday publish moved to 9:30 PM Pacific ──────────────────

test("schedule automation: Sunday publish moved to 9:30 PM Pacific", async () => {
  const sql = await readFile(moveSundayPublish930MigrationUrl, "utf8");

  // Unschedules the 8:45 PM Sunday cron before re-scheduling it
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);

  // New schedule: '30 4,5 * * 1' = Mon 04:30 and 05:30 UTC (9:30 PM Pacific,
  // DST-proofed — the off-DST fire is an idempotent no-op once published).
  assert.match(sql, /30 4,5 \* \* 1/);

  // Calls the surgical wrapper (preserves confirmed drives, fits late riders
  // into spare capacity). Does NOT call generate_schedule_cron (full regen),
  // which would reshuffle confirmed drives and regress PR #126.
  assert.match(sql, /publish_and_update_schedule/);
  assert.doesNotMatch(sql, /generate_schedule_cron/);

  // Saturday draft cron is NOT touched by this move
  assert.doesNotMatch(sql, /generate-schedule-saturday/);
});

// ─── Sunday publish moved to 7:15 PM Pacific (final) ──────────

test("schedule automation: Sunday publish moved to 7:15 PM Pacific", async () => {
  const sql = await readFile(moveSundayPublish715MigrationUrl, "utf8");

  // Unschedules the 9:30 PM Sunday cron before re-scheduling it
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);

  // New schedule: '15 2,3 * * 1' = Mon 02:15 and 03:15 UTC (7:15 PM Pacific,
  // DST-proofed — the off-DST fire is an idempotent no-op once published).
  assert.match(sql, /15 2,3 \* \* 1/);

  // Calls the surgical wrapper (preserves confirmed drives, fits late riders
  // into spare capacity). Does NOT call generate_schedule_cron (full regen),
  // which would reshuffle confirmed drives and regress PR #126.
  assert.match(sql, /publish_and_update_schedule/);
  assert.doesNotMatch(sql, /generate_schedule_cron/);

  // Saturday draft cron is NOT touched by this move
  assert.doesNotMatch(sql, /generate-schedule-saturday/);
});

// ─── Sunday night-before suppressed (Mon–Thu only) ────────────

test("night-before: Sunday suppressed, Mon–Thu only", async () => {
  const sql = await readFile(suppressSundayNightBeforeMigrationUrl, "utf8");

  // Unschedules the Sun–Thu night-before cron
  assert.match(sql, /cron\.unschedule\('night-before-summary'\)/);

  // New schedule: '45 2,3 * * 1-4' = Mon–Thu only (no Sunday)
  assert.match(sql, /45 2,3 \* \* 1-4/);
  assert.match(sql, /send_night_before_summary/);
});

// ─── Coordinator removes child from drive RPC ─────────────────

test("cancel_ride_by_coordinator: RPC gates on is_group_coordinator, not is_household_member", async () => {
  const sql = await readFile(cancelRideByCoordinatorMigrationUrl, "utf8");

  // Creates the RPC with security definer
  assert.match(sql, /create or replace function public\.cancel_ride_for_child_by_coordinator/);
  assert.match(sql, /security definer/);

  // Gates on is_group_coordinator (NOT is_household_member)
  assert.match(sql, /is_group_coordinator/);
  assert.doesNotMatch(sql, /is_household_member/);

  // Requires auth
  assert.match(sql, /auth\.uid\(\) is null/);

  // Published-schedule guard
  assert.match(sql, /status <> 'published'/);

  // Deletes the rider_assignment
  assert.match(sql, /delete from public\.rider_assignments/);

  // Audits as ride_cancelled_by_coordinator
  assert.match(sql, /ride_cancelled_by_coordinator/);

  // Revokes public access, grants to authenticated
  assert.match(sql, /revoke all on function public\.cancel_ride_for_child_by_coordinator/);
  assert.match(sql, /grant execute on function public\.cancel_ride_for_child_by_coordinator/);
});

// ─── pg_net timeout fix (root cause of night-before silence) ──

test("pg_net timeout: all wrapper functions use 120s timeout", async () => {
  const sql = await readFile(pgnetTimeoutMigrationUrl, "utf8");

  // All three wrapper functions are rewritten with CREATE OR REPLACE
  assert.match(sql, /create or replace function public\.send_night_before_summary\(\)/);
  assert.match(sql, /create or replace function public\.send_drive_reminders\(\)/);
  assert.match(sql, /create or replace function public\.generate_schedule_cron\(\)/);

  // All three include timeout_milliseconds := 120000 (the fix)
  assert.match(sql, /timeout_milliseconds := 120000/);

  // All three use security definer + revoke
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_night_before_summary\(\) from public, authenticated/);
  assert.match(sql, /revoke all on function public\.send_drive_reminders\(\) from public, authenticated/);
  assert.match(sql, /revoke all on function public\.generate_schedule_cron\(\) from public, authenticated/);

  // All three use vault secrets (environment-aware)
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);
});

test("pg_net timeout: remaining wrapper functions use 120s timeout", async () => {
  const sql = await readFile(pgnetTimeoutRemainingMigrationUrl, "utf8");

  // Both wrapper functions are rewritten with CREATE OR REPLACE
  assert.match(sql, /create or replace function public\.send_deadline_reminders\(\)/);
  assert.match(sql, /create or replace function public\.send_welcome_email\(\)/);

  // Both include timeout_milliseconds := 120000 (the fix)
  assert.match(sql, /timeout_milliseconds := 120000/);

  // Both use security definer + revoke
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_deadline_reminders\(\) from public, authenticated/);
  assert.match(sql, /revoke all on function public\.send_welcome_email\(\) from public, authenticated/);

  // Both use vault secrets (environment-aware)
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);

  // Welcome email is a trigger function (RETURNS trigger)
  assert.match(sql, /returns trigger/);

  // Deadline reminder is a void function
  assert.match(sql, /returns void/);
});

// ─── publish_schedule_internal RPC ──────────────────────────

test("publish_schedule_internal: service-role RPC with no auth.uid() check", async () => {
  const sql = await readFile(publishInternalMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.publish_schedule_internal\(/);
  assert.match(sql, /p_group_id uuid,/);
  assert.match(sql, /p_version_id uuid,/);
  assert.match(sql, /p_actor_id uuid/);
  assert.match(sql, /security definer/);

  // Must NOT check auth.uid() for coordinator (unlike publish_schedule)
  assert.doesNotMatch(sql, /auth\.uid\(\)\s+into\s+v_is_coordinator/);
  assert.doesNotMatch(sql, /not_coordinator/);

  // Must revoke from authenticated (service role bypasses grants)
  assert.match(sql, /revoke all on function public\.publish_schedule_internal\(uuid, uuid, uuid\) from public, authenticated/);

  // Must expire tentative and supersede prior published
  assert.match(sql, /set status = 'expired'/);
  assert.match(sql, /set status = 'superseded'/);
  assert.match(sql, /set status = 'published', published_at = now\(\)/);

  // Must audit with p_actor_id
  assert.match(sql, /p_actor_id, 'schedule_published'/);
  assert.match(sql, /'source', 'auto'/);
});

// ─── manually_assign_driver RPC ─────────────────────────────

test("manually_assign_driver: coordinator-only, no availability check", async () => {
  const sql = await readFile(manualAssignMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.manually_assign_driver\(/);
  assert.match(sql, /p_trip_id uuid,/);
  assert.match(sql, /p_schedule_version_id uuid,/);
  assert.match(sql, /p_driver_profile_id uuid,/);
  assert.match(sql, /p_vehicle_id uuid/);
  assert.match(sql, /security definer/);

  // Must check caller is coordinator
  assert.match(sql, /role = 'coordinator'/);
  assert.match(sql, /Only coordinators can manually assign drivers/);

  // Must NOT check driver_availability or preference (admin overrides availability)
  assert.doesNotMatch(sql, /driver_availability/);
  assert.doesNotMatch(sql, /preference/);

  // Must verify target is active member and vehicle is active
  assert.match(sql, /status = 'active'/);
  assert.match(sql, /active = true/);

  // Must create confirmed assignment
  assert.match(sql, /'confirmed'/);

  // Must move/insert rider_assignments for uncovered children
  assert.match(sql, /on conflict \(schedule_version_id, trip_id, child_id\)/);
  assert.match(sql, /do update set driver_assignment_id = excluded\.driver_assignment_id/);

  // Must audit
  assert.match(sql, /'driver_manually_assigned'/);
  assert.match(sql, /'source', 'manual'/);

  // Must grant to authenticated (coordinator check is inside the function)
  assert.match(sql, /grant execute on function public\.manually_assign_driver\(uuid, uuid, uuid, uuid\) to authenticated/);
});

// ─── reassign_driver RPC (admin reassign from DriveDetailScreen) ──

test("reassign_driver: coordinator-only, moves riders, releases old assignment", async () => {
  const sql = await readFile(reassignDriverMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.reassign_driver\(/);
  assert.match(sql, /p_assignment_id uuid,/);
  assert.match(sql, /p_new_driver_profile_id uuid,/);
  assert.match(sql, /p_vehicle_id uuid/);
  assert.match(sql, /security definer/);

  // Must check caller is coordinator
  assert.match(sql, /role = 'coordinator'/);
  assert.match(sql, /Only coordinators can reassign drivers/);

  // Must only reassign active drives
  assert.match(sql, /Can only reassign an active \(tentative or confirmed\) drive/);

  // New driver guards: differs from outgoing, active member, not already on the trip
  assert.match(sql, /New driver is the same as the current driver/);
  assert.match(sql, /New driver is not an active member of this group/);
  assert.match(sql, /New driver is already assigned to this trip/);

  // Must enforce vehicle capacity up front (don't strand riders)
  assert.match(sql, /Vehicle too small for current riders/);

  // Must create confirmed assignment
  assert.match(sql, /'confirmed'/);

  // THE FIX: must move ALL riders from the old assignment, not just uncovered ones
  assert.match(sql, /update public\.rider_assignments\s+set driver_assignment_id = new_assignment\.id\s+where driver_assignment_id = v_old\.id/);

  // Must release the outgoing assignment (app renders: "Another driver took this drive")
  assert.match(sql, /set status = 'released', updated_at = now\(\)\s+where id = v_old\.id/);

  // Must audit
  assert.match(sql, /'driver_reassigned'/);
  assert.match(sql, /'riders_moved'/);

  // Must grant to authenticated (coordinator check is inside the function)
  assert.match(sql, /grant execute on function public\.reassign_driver\(uuid, uuid, uuid\) to authenticated/);
});

test("reassign_driver: UI uses it from DriveDetailScreen admin section (not manually_assign_driver)", async () => {
  const repo = await readFile(new URL("../src/lib/supabase/carpool-repository.ts", import.meta.url), "utf8");

  // Repository method calls the reassign_driver RPC
  assert.match(repo, /reassign_driver/);

  // RPC is typed in database.types.ts
  const types = await readFile(new URL("../src/lib/supabase/database.types.ts", import.meta.url), "utf8");
  assert.match(types, /reassign_driver: \{/);
  assert.match(types, /p_assignment_id: string;/);

  // Prototype wires the admin reassign to the new callback with the old assignment id
  const tsx = await readFile(new URL("../src/Prototype.tsx", import.meta.url), "utf8");
  assert.match(tsx, /reassignDriver\(assignmentId, driverProfileId, vehicleId\)/);
  assert.match(tsx, /onReassign\(entry\.driverAssignment\.id, driverProfileId, vehicleId\)/);

  // Outgoing driver gets a "You're no longer driving" notification
  assert.match(tsx, /sendDriveReassignedNotification\(assignmentId, newAssignment\.id\)/);
  const edge = await readFile(new URL("../supabase/functions/send-push/index.ts", import.meta.url), "utf8");
  assert.match(edge, /type === "drive_reassigned" && assignment_id/);
  assert.match(edge, /new_assignment_id/);
  assert.match(edge, /You're no longer driving/);
  assert.match(edge, /is now driving the \$\{period\} trip on/);
});

// ─── generate-schedule Edge Function ────────────────────────

test("generate-schedule: accepts cron/service-role auth and auto-publishes at deadline", async () => {
  const ts = await readFile(generateScheduleUrl, "utf8");

  // Cron secret auth path
  assert.match(ts, /isSystemCall = source === "cron"/);
  assert.match(ts, /CRON_SECRET/);
  assert.match(ts, /SERVICE_ROLE_KEY/);

  // Service-role client for system calls
  assert.match(ts, /writeClient/);

  // Skips coordinator check for system calls
  assert.match(ts, /if \(!isSystemCall && userId\)/);

  // Loads deadlines from week row
  assert.match(ts, /checkin_deadline, confirmation_deadline/);
  assert.match(ts, /deadlinePassed/);

  // Auto-publish: clean republish OR deadline auto-publish
  assert.match(ts, /cleanRepublish = wasPublished && !hasUncovered && !hasTentative/);
  assert.match(ts, /deadlineAutoPublish = deadlinePassed && !wasPublished/);
  assert.match(ts, /shouldAutoPublish = cleanRepublish || deadlineAutoPublish/);

  // Uses publish_schedule_internal for system calls
  assert.match(ts, /publish_schedule_internal/);

  // Sends push notifications after auto-publish
  assert.match(ts, /"published"/);
  assert.match(ts, /"uncovered"/);
  assert.match(ts, /"admin_escalation"/);

  // Response includes auto_published flag
  assert.match(ts, /auto_published: autoPublished/);
});

// ─── send-push Edge Function ────────────────────────────────

test("send-push: supports admin_escalation and manually_assigned types", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // admin_escalation: notify coordinators of uncovered trips
  assert.match(ts, /type === "admin_escalation" && version_id/);
  assert.match(ts, /role: "eq.coordinator"/);
  assert.match(ts, /Schedule needs attention/);

  // manually_assigned: notify the assigned driver only
  assert.match(ts, /type === "manually_assigned" && assignment_id/);
  assert.match(ts, /recipientProfileIds = \[da\.driver_profile_id\]/);
  assert.match(ts, /You've been assigned/);
});

test("send-push: sends transactional email via Resend alongside push", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Reads Resend config from env (email is skipped when RESEND_API_KEY unset)
  assert.match(ts, /RESEND_API_KEY/);
  assert.match(ts, /RESEND_FROM_EMAIL/);
  assert.match(ts, /RESEND_REPLY_TO/);

  // Reads APP_URL env var for the email CTA
  assert.match(ts, /APP_URL/);

  // POSTs to Resend with an idempotency key per recipient
  assert.match(ts, /api\.resend\.com\/emails/);
  assert.match(ts, /Idempotency-Key/);
  assert.match(ts, /carpool-\$\{tag\}-\$\{profile\.id\}/);

  // HTML body wraps the same bodyText, escaped; subject reuses push title
  assert.match(ts, /escapeHtml\(bodyText\)/);
  assert.match(ts, /Carpool Crew/);
  assert.match(ts, /subject: title/);

  // Recipients without a push subscription still get an email — no early
  // return on empty subscriptions
  assert.match(ts, /No early return when subscriptions is empty/);

  // Reports email stats in the response alongside push stats
  assert.match(ts, /email_sent: emailSent/);
  assert.match(ts, /email_failed: emailFailed/);

  // Skips all test/seed/demo emails — any address ending in "kidpool"
  assert.match(ts, /isTestEmail/);
  assert.match(ts, /endsWith\("kidpool"\)/);
});

test("send-push: PostgREST filters use proper operator syntax (eq., in.)", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // supaFetch accepts array tuples for range queries (same column, two filters)
  assert.match(ts, /Array<\[string, string\]>/);

  // No bare "column.in" key patterns — should be column key with in.() value
  assert.doesNotMatch(ts, /"id\.in"/);
  assert.doesNotMatch(ts, /"profile_id\.in"/);

  // No bare UUID/string filter values — all use eq. prefix
  assert.doesNotMatch(ts, /status: "active"/);
  assert.doesNotMatch(ts, /needs_ride: "true"/);
});

// ─── Deadline reminder cron re-enablement ───────────────────

test("deadline cron: re-enabled with environment-aware vault pattern", async () => {
  const sql = await readFile(deadlineCronMigrationUrl, "utf8");

  // Rewrites the function to use cron_edge_base_url (not supabase_url or hardcoded URL)
  assert.match(sql, /create or replace function public\.send_deadline_reminders\(\)/);
  assert.match(sql, /cron_edge_base_url/);
  assert.doesNotMatch(sql, /ujcrnrcgbvzyqosykkjy/);
  // No hardcoded fallback URL in the function body — only vault secrets
  assert.doesNotMatch(sql, /v_supabase_url/);

  // Security definer, revoked from public/authenticated
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_deadline_reminders\(\) from public, authenticated/);

  // Re-schedules the hourly cron
  assert.match(sql, /cron\.schedule/);
  assert.match(sql, /checkin-deadline-reminder/);
  assert.match(sql, /0 \* \* \* \*/);
});

test("send-push: deadline_reminder tag includes date for idempotency", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Tag includes the current date in the pilot timezone (America/Los_Angeles)
  // so the email idempotency key changes daily (at most one reminder email
  // per family per day, even if cron fires hourly). Using SF time instead of
  // UTC prevents duplicate reminders when cron fires around midnight UTC.
  assert.match(ts, /checkin-reminder-\$\{todayStr\}-\$\{m\.profile_id\}/);
});

// ─── Welcome email ─────────────────────────────────────────

test("welcome email: DB trigger fires on auth.users INSERT", async () => {
  const sql = await readFile(welcomeEmailMigrationUrl, "utf8");

  // Trigger function uses vault secrets, environment-aware
  assert.match(sql, /create or replace function public\.send_welcome_email\(\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /cron_edge_base_url/);
  assert.match(sql, /cron_secret/);
  assert.doesNotMatch(sql, /ujcrnrcgbvzyqosykkjy/);

  // Fires on INSERT only, not update
  assert.match(sql, /tg_op <> 'INSERT'/);
  assert.match(sql, /after insert on auth\.users/);
  assert.match(sql, /on_auth_user_welcome_email/);

  // Revoked from public/authenticated
  assert.match(sql, /revoke all on function public\.send_welcome_email\(\) from public, authenticated/);

  // POSTs to send-push with type=welcome
  assert.match(sql, /'type', 'welcome'/);
  assert.match(sql, /'email'/);
  assert.match(sql, /'user_id'/);
});

test("send-push: welcome type sends email-only onboarding welcome", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Welcome branch handled before the regular recipient-resolution block
  assert.match(ts, /type === "welcome"/);

  // Email-only: no push subscriptions, no profile lookup
  assert.match(ts, /email-only, no push, no profile lookup/);

  // Idempotency key uses user_id to prevent duplicate sends
  assert.match(ts, /welcome-\$\{userId\}/);

  // Skips all test/seed/demo emails (any address ending in "kidpool")
  assert.match(ts, /isTestEmail/);

  // Subject is the welcome subject
  assert.match(ts, /subject: "Welcome to Carpool Crew"/);

  // HTML covers the 4 key topics (household section removed — app teaches it inline)
  assert.match(ts, /The three tabs/);
  assert.match(ts, /Check in by Saturday midnight/);
  assert.match(ts, /Set your standard week/);
  assert.match(ts, /Install the app on your phone/);

  // Standard week ≠ auto check-in — highlighted callout
  assert.match(ts, /does not check you in automatically/);

  // Install instructions for both platforms
  assert.match(ts, /Add to Home Screen/);
  assert.match(ts, /iPhone/);
  assert.match(ts, /Android/);

  // Has plain-text fallback body
  assert.match(ts, /textBody/);
});

// ─── CarpoolRepository ───────────────────────────────────────

test("repository: manuallyAssignDriver and getDeclinedWithoutVolunteer methods", async () => {
  const ts = await readFile(repositoryUrl, "utf8");

  // manuallyAssignDriver wraps the RPC
  assert.match(ts, /async manuallyAssignDriver\(/);
  assert.match(ts, /"manually_assign_driver"/);
  assert.match(ts, /p_trip_id: tripId,/);
  assert.match(ts, /p_schedule_version_id: scheduleVersionId,/);
  assert.match(ts, /p_driver_profile_id: driverProfileId,/);
  assert.match(ts, /p_vehicle_id: vehicleId/);

  // getDeclinedWithoutVolunteer is admin-scoped
  assert.match(ts, /async getDeclinedWithoutVolunteer\(/);
  assert.match(ts, /Admin-scoped/);
  assert.match(ts, /getDeclinedWithoutVolunteer/);

  // sendPushNotification accepts new types
  assert.match(ts, /"declined" \| "uncovered" \| "published" \| "volunteered" \| "admin_escalation" \| "manually_assigned"/);

  // GenerateScheduleResult includes auto_published
  assert.match(ts, /auto_published\?: boolean/);
});

// ─── Prototype.tsx ───────────────────────────────────────────

test("prototype: tab renamed to Admin, triage board layout", async () => {
  const tsx = await readFile(prototypeUrl, "utf8");

  // Tab label is "Admin" not "Status"
  assert.match(tsx, /label: "Admin", icon: GroupIcon/);
  assert.doesNotMatch(tsx, /label: "Status"/);

  // Eyebrow is consistently "Admin"
  assert.doesNotMatch(tsx, /"Admin view" : "Status"/);

  // Triage board sections
  assert.match(tsx, /admin-triage/);
  assert.match(tsx, /Needs your attention/);
  assert.match(tsx, /On track/);
  assert.match(tsx, /admin-override/);
  assert.match(tsx, /Automated Sun 7 AM/);

  // Status line with auto-publish info
  assert.match(tsx, /admin-status-line/);
  assert.match(tsx, /Auto-publishes/);

  // Manual-assign sheet
  assert.match(tsx, /adminAssignTarget/);
  assert.match(tsx, /onManuallyAssign/);
  assert.match(tsx, /Assign a driver/);
  assert.match(tsx, /assign-driver-list/);

  // Preserved data-testid attributes
  assert.match(tsx, /data-testid="coordinator-screen"/);
  assert.match(tsx, /data-testid="decline-alert-admin"/);
  assert.match(tsx, /data-testid="uncovered-alert-admin"/);
  assert.match(tsx, /data-testid="generate-schedule-coord"/);
  assert.match(tsx, /data-testid="publish-schedule"/);
  assert.match(tsx, /data-testid="confirm-regenerate"/);
  assert.match(tsx, /data-testid="regenerate-schedule-coord"/);
  assert.match(tsx, /data-testid="generate-warning"/);

  // Week status section (driver confirmation state per trip)
  assert.match(tsx, /data-testid="week-status-section"/);
  assert.match(tsx, /data-testid="week-status-strip"/);
  assert.match(tsx, /week-status-detail/);
  assert.match(tsx, /week-status-checkins/);
});

// ─── volunteer_for_uncovered_trip: already-driving fix ─────

test("volunteer_uncovered: reuses existing assignment when caller is already driving", async () => {
  const sql = await readFile(volunteerAlreadyDrivingMigrationUrl, "utf8");

  // Rewrites the RPC
  assert.match(sql, /create or replace function public\.volunteer_for_uncovered_trip\(/);

  // Detects existing tentative/confirmed assignment
  assert.match(sql, /existing_assignment/);
  assert.match(sql, /status in \('tentative', 'confirmed'\)/);

  // Uses existing assignment instead of creating a new one
  assert.match(sql, /new_assignment := existing_assignment/);

  // Checks capacity before adding children to existing car
  assert.match(sql, /v_available_capacity/);
  assert.match(sql, /car is full/);

  // No longer raises the old "already assigned" error as an exception
  assert.doesNotMatch(sql, /raise exception 'You are already assigned to drive this trip'/);

  // Audits whether it reused an existing assignment
  assert.match(sql, /reused_existing_assignment/);
});

// ─── Night-before summary cron ──────────────────────────────

test("night-before summary: cron wrapper uses environment-aware vault pattern", async () => {
  const sql = await readFile(nightBeforeSummaryMigrationUrl, "utf8");

  // Creates the wrapper function
  assert.match(sql, /create or replace function public\.send_night_before_summary\(\)/);
  assert.match(sql, /cron_edge_base_url/);
  assert.match(sql, /cron_secret/);
  assert.doesNotMatch(sql, /ujcrnrcgbvzyqosykkjy/);

  // Security definer, revoked from public/authenticated
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_night_before_summary\(\) from public, authenticated/);

  // POSTs to send-push with type=night_before_summary
  assert.match(sql, /'type', 'night_before_summary'/);

  // Schedules hourly — the Edge Function gates to 8 PM Pacific
  assert.match(sql, /cron\.schedule/);
  assert.match(sql, /night-before-summary/);
  assert.match(sql, /0 \* \* \* \*/);
});

test("send-push: night_before_summary branch sends personalized email + push", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch handled with its own early-return (per-recipient custom content)
  assert.match(ts, /type === "night_before_summary"/);
  assert.match(ts, /night_before_summary: "who's driving tomorrow" email \+ push/);

  // No time gate — the cron fires at the right time (7:45 PM Pacific)
  assert.doesNotMatch(ts, /pacificHour < 21/);

  // Idempotency key is date-stamped per recipient
  assert.match(ts, /night-before-\$\{tomorrow\}-\$\{profile\.id\}/);

  // Skips all test/seed/demo emails (any address ending in "kidpool")
  assert.match(ts, /isTestEmail/);

  // Personalized driving status section + full roster
  assert.match(ts, /Tomorrow's carpool/);
  assert.match(ts, /You're driving tomorrow/);
  assert.match(ts, /You're not driving tomorrow/);
  assert.match(ts, /Tomorrow's drivers/);

  // Sends push notification (personal section only) alongside email
  assert.match(ts, /pushSent/);
  assert.match(ts, /webpush\.sendNotification/);

  // Resend tags include the type
  assert.match(ts, /value: "night_before_summary"/);
});

// ─── Drive reminder cron ─────────────────────────────────────

test("drive reminder: cron wrapper uses environment-aware vault pattern", async () => {
  const sql = await readFile(driveReminderMigrationUrl, "utf8");

  // Creates the wrapper function
  assert.match(sql, /create or replace function public\.send_drive_reminders\(\)/);
  assert.match(sql, /cron_edge_base_url/);
  assert.match(sql, /cron_secret/);
  assert.doesNotMatch(sql, /ujcrnrcgbvzyqosykkjy/);

  // Security definer, revoked from public/authenticated
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_drive_reminders\(\) from public, authenticated/);

  // POSTs to send-push with type=drive_reminder
  assert.match(sql, /'type', 'drive_reminder'/);

  // Schedules at :00 and :25 every hour
  assert.match(sql, /cron\.schedule/);
  assert.match(sql, /drive-reminder/);
  assert.match(sql, /0,25 \* \* \* \*/);
});

test("send-push: drive_reminder branch sends push + email to confirmed drivers", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch handled with its own early-return (per-driver custom content)
  assert.match(ts, /type === "drive_reminder"/);
  assert.match(ts, /90 min/);

  // Data-driven gate: queries today's trips and computes meeting_time - 90 min
  assert.match(ts, /addMinutes/);
  assert.match(ts, /todayTrips/);

  // Only confirmed drivers (not tentative)
  assert.match(ts, /status: "eq.confirmed"/);

  // Idempotency key is per-trip-per-driver
  assert.match(ts, /drive-reminder-\$\{trip\.id\}-\$\{da\.driver_profile_id\}/);

  // Push title + email subject
  assert.match(ts, /Drive in 90 minutes/);

  // Lists kids in the car
  assert.match(ts, /Kids in your car/);

  // Skips all test/seed/demo emails (any address ending in "kidpool")
  assert.match(ts, /isTestEmail/);

  // Resend tags include the type
  assert.match(ts, /value: "drive_reminder"/);
});

// ─── Status reminder (30-min pre-drive action prompt) ─────────

test("send-push: status_reminder branch sends action prompts to drivers + rider parents", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch handled with its own early-return
  assert.match(ts, /type === "status_reminder"/);
  assert.match(ts, /30-min pre-drive action prompt/);

  // Data-driven gate: queries today's trips and computes meeting_time - 30 min
  assert.match(ts, /addMinutes/);
  assert.match(ts, /todayTrips/);

  // Only confirmed drivers
  assert.match(ts, /status: "eq.confirmed"/);

  // Driver prompt: "Tap I'm on my way"
  assert.match(ts, /Tap "I'm on my way"/);
  assert.match(ts, /On your way soon\?/);

  // Rider parent prompt (morning only): "Mark ready"
  assert.match(ts, /Mark ready/);
  assert.match(ts, /isMorning/);

  // Afternoon rider parents skipped (no "ready" status for afternoon)
  assert.match(ts, /Afternoon rider parents get nothing/);
});

// ─── Drive confirmed email (calendar invite) ────────────────

test("send-push: drive_confirmed branch sends calendar invite email", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch handled with its own early-return
  assert.match(ts, /type === "drive_confirmed"/);
  assert.match(ts, /drive_confirmed: email calendar invite to the confirmed driver/);

  // Sends to the confirmed driver only (not all members)
  assert.match(ts, /Assignment not found/);

  // Guard: only sends for confirmed/tentative assignments (not released/declined)
  assert.match(ts, /assignment_\$\{da\.status\}/);

  // Idempotency key includes updated_at so re-accept after cancel gets a fresh key
  assert.match(ts, /drive-confirmed-\$\{assignment_id\}-\$\{da\.updated_at\}/);

  // Email has .ics attachment
  assert.match(ts, /attachments/);
  assert.match(ts, /carpool-crew-drive\.ics/);

  // ICS uses 15 min before meeting + 45 min after departure (1-hour event)
  assert.match(ts, /addMinutes\(trip\.meeting_time, -15\)/);
  assert.match(ts, /addMinutes\(trip\.departure_time, 45\)/);

  // ICS content includes VCALENDAR + VEVENT
  assert.match(ts, /BEGIN:VCALENDAR/);
  assert.match(ts, /BEGIN:VEVENT/);
  assert.match(ts, /DTSTART;TZID=/);
  assert.match(ts, /DTEND;TZID=/);

  // Skips test emails
  assert.match(ts, /isTestEmail/);

  // Resend tags include the type
  assert.match(ts, /value: "drive_confirmed"/);
});

test("send-push: drive_cancelled branch sends calendar cancellation email", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch handled with its own early-return
  assert.match(ts, /type === "drive_cancelled"/);
  assert.match(ts, /drive_cancelled: calendar cancellation email to the driver/);

  // ICS uses METHOD:CANCEL so calendar apps remove the event
  assert.match(ts, /METHOD:CANCEL/);
  assert.match(ts, /STATUS:CANCELLED/);

  // Email has .ics attachment
  assert.match(ts, /carpool-crew-cancel\.ics/);

  // Same UID as the confirm email (so calendar app updates the same event)
  assert.match(ts, /UID:drive-confirmed-\$\{assignment_id\}@carpoolcrew\.co/);

  // Idempotency key includes updated_at
  assert.match(ts, /drive-cancelled-\$\{assignment_id\}-\$\{da\.updated_at\}/);

  // Skips test emails
  assert.match(ts, /isTestEmail/);

  // Resend tags include the type
  assert.match(ts, /value: "drive_cancelled"/);
});

// ─── Broadcast type ──────────────────────────────────────────

test("send-push: broadcast type sends arbitrary email to all active members", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch accepts content from the request body
  assert.match(ts, /type === "broadcast"/);
  assert.match(ts, /broadcast_id/);
  assert.match(ts, /html_body/);
  assert.match(ts, /text_body/);

  // Sends to all active memberships in the pilot group
  assert.match(ts, /broadcast: one-off email to all active members/);

  // Idempotency key uses broadcast_id + profile_id
  assert.match(ts, /broadcast-\$\{broadcastId\}-\$\{profile\.id\}/);

  // Skips all test/seed/demo emails (any address ending in "kidpool")
  assert.match(ts, /isTestEmail/);

  // Resend tags include the type
  assert.match(ts, /value: "broadcast"/);

  // Supports filtering to a single email (for test sends)
  assert.match(ts, /filter_email/);
});

// ─── Fix volunteer re-accept (undo PR #93 restore logic) ─────

test("fix volunteer re-accept: RPC does NOT restore released assignments", async () => {
  const sql = await readFile(fixVolunteerReacceptMigrationUrl, "utf8");

  // Rewrites the RPC with CREATE OR REPLACE (reverts to pre-#93 logic)
  assert.match(sql, /create or replace function public\.respond_to_driver_assignment\(/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.respond_to_driver_assignment\(uuid, public\.confirmation_response, text\) from public/);

  // Does NOT contain the restore logic in the function body
  // (the comments mention PR #93's bug, but the function body should not
  // have the restore variables or rider move-back logic)
  assert.doesNotMatch(sql, /v_released_assignment public\.driver_assignments/);
  assert.doesNotMatch(sql, /v_other_active_count integer/);
  assert.doesNotMatch(sql, /set driver_assignment_id = v_released_assignment\.id/);

  // 'released' stays blocked from re-accept (the volunteer can re-accept, not the original driver)
  assert.match(sql, /assignment\.status not in \('tentative', 'confirmed', 'declined', 'expired'\)/);
});

test("fix volunteer re-accept: data fix moves riders back to volunteer", async () => {
  const sql = await readFile(fixVolunteerReacceptMigrationUrl, "utf8");

  // Data fix: moves riders from the restored (wrong) assignment to the 0-rider assignment
  assert.match(sql, /update public\.rider_assignments/);
  assert.match(sql, /set driver_assignment_id = r\.no_riders_id/);
  assert.match(sql, /where driver_assignment_id = r\.with_riders_id/);

  // Sets the restored assignment back to 'released'
  assert.match(sql, /set status = 'released'/);

  // Only matches pairs where the with_riders assignment was restored by PR #93
  assert.match(sql, /released_assignment_restored/);

  // Audit event for the revert
  assert.match(sql, /released_assignment_reverted/);
});

// ─── Allow released re-accept with rider transfer ────────────

test("released re-accept: RPC allows released status and transfers riders", async () => {
  const sql = await readFile(allowReleasedReacceptMigrationUrl, "utf8");

  // Rewrites the RPC with CREATE OR REPLACE
  assert.match(sql, /create or replace function public\.respond_to_driver_assignment\(/);
  assert.match(sql, /security definer/);

  // 'released' is now in the allowed statuses
  assert.match(sql, /'tentative', 'confirmed', 'declined', 'expired', 'released'/);

  // 0-rider guard covers both 'expired' AND 'declined' (not just expired)
  assert.match(sql, /if assignment\.status in \('expired', 'declined'\)/);

  // released guard: blocks if another confirmed/tentative driver exists
  assert.match(sql, /if assignment\.status = 'released'/);
  assert.match(sql, /v_other_active_count > 0/);

  // Rider transfer on released re-accept
  assert.match(sql, /if driver_response = 'confirmed' and assignment\.status = 'confirmed'/);
  assert.match(sql, /status in \('declined', 'expired'\)/);
  assert.match(sql, /update public\.rider_assignments/);
  assert.match(sql, /set driver_assignment_id = assignment\.id/);

  // Audit for rider transfer
  assert.match(sql, /riders_transferred/);
});

test("released re-accept: reacceptDrive sends volunteered notification", async () => {
  const ts = await readFile(prototypeUrl, "utf8");

  // reacceptDrive sends both drive_confirmed and volunteered
  assert.match(ts, /drive_confirmed/);
  assert.match(ts, /volunteered/);
});

test("released re-accept: Review screen sends volunteered on re-accept (not tentative)", async () => {
  const ts = await readFile(prototypeUrl, "utf8");

  // Check prior status before sending volunteered on confirm
  assert.match(ts, /priorStatus/);
  assert.match(ts, /priorStatus === "declined" || priorStatus === "expired" || priorStatus === "released"/);
});

test("released re-accept: UI shows released in reacceptableAssignments", async () => {
  const ts = await readFile(prototypeUrl, "utf8");

  // released is in the reacceptable filter
  assert.match(ts, /a\.assignment\.status === "released"/);
});

test("released re-accept: repository suppresses I-can-drive for released trips", async () => {
  const ts = await readFile(repositoryUrl, "utf8");

  // Fetches the user's released assignments
  assert.match(ts, /eq\("status", "released"\)/);

  // Builds a set of released trip_ids to suppress
  assert.match(ts, /myReleasedTripIds/);
  assert.match(ts, /myReleasedTripIds\.has\(da\.trip_id\)/);
});

// ─── Fixed-time notification schedule ────────────────────────

test("notification schedule: unschedules hourly crons and creates 5 fixed-time crons", async () => {
  const sql = await readFile(fixNotificationScheduleMigrationUrl, "utf8");

  // Unschedules the 2 hourly crons
  assert.match(sql, /cron\.unschedule\('checkin-deadline-reminder'\)/);
  assert.match(sql, /cron\.unschedule\('confirmation-deadline-reminder'\)/);

  // Re-applies the 8:30 PM Pacific Sunday publish schedule (was overwritten)
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);
  assert.match(sql, /30 3,4 \* \* 1/);

  // 3 check-in reminder crons (Sat 9 AM, 6 PM, 11 PM Pacific)
  assert.match(sql, /checkin-reminder-9am/);
  assert.match(sql, /0 16,17 \* \* 6/);
  assert.match(sql, /checkin-reminder-6pm/);
  assert.match(sql, /0 1,2 \* \* 0/);
  assert.match(sql, /checkin-reminder-11pm/);
  assert.match(sql, /0 6,7 \* \* 0/);

  // 2 confirmation reminder crons (Sun 8 AM, 7 PM Pacific)
  assert.match(sql, /confirmation-reminder-8am/);
  assert.match(sql, /0 15,16 \* \* 0/);
  assert.match(sql, /confirmation-reminder-7pm/);
  assert.match(sql, /0 2,3 \* \* 1/);

  // All 5 wrapper functions use 120s timeout
  assert.match(sql, /timeout_milliseconds := 120000/);

  // All 5 use vault secrets (environment-aware)
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);

  // All 5 are security definer + revoked
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_checkin_reminder_9am\(\) from public, authenticated/);
  assert.match(sql, /revoke all on function public\.send_confirmation_reminder_8am\(\) from public, authenticated/);
});

test("notification schedule: send-push has checkin_reminder + confirmation_reminder branches", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // New branches exist
  assert.match(ts, /type === "checkin_reminder"/);
  assert.match(ts, /type === "confirmation_reminder"/);

  // Old branches are gone (deadline_reminder removed; confirmation_reminder
  // is reused but the old urgency-tier logic and missed-deadline logic are gone)
  assert.doesNotMatch(ts, /type === "deadline_reminder"/);
  assert.doesNotMatch(ts, /hoursLeft > 24/);
  assert.doesNotMatch(ts, /Missed check-in deadline/);
  assert.doesNotMatch(ts, /Drives expired/);

  // checkin_reminder: finds unsubmitted households and sends
  assert.match(ts, /checkin_reminder/);
  assert.match(ts, /eq\.submitted/);
  assert.match(ts, /sendEmailAndPush/);

  // confirmation_reminder: finds tentative drivers and sends
  assert.match(ts, /confirmation_reminder/);
  assert.match(ts, /eq\.tentative/);
  assert.match(ts, /sendEmailAndPush/);

  // Both use per-date idempotency keys (DST-proof dedup)
  assert.match(ts, /checkin-reminder-\$\{todayStr\}-\$\{m\.profile_id\}/);
  assert.match(ts, /confirmation-reminder-\$\{todayStr\}-\$\{driverId\}/);
});

// ─── Night-before moved to 7:45 PM Pacific ───────────────────

test("night-before 7:45pm: replaces hourly cron with fixed 7:45 PM schedule", async () => {
  const sql = await readFile(moveNightBeforeMigrationUrl, "utf8");

  // Unschedules the old hourly cron
  assert.match(sql, /cron\.unschedule\('night-before-summary'\)/);

  // New schedule: 7:45 PM Pacific = 02:45/03:45 UTC, Sun-Thu nights
  assert.match(sql, /45 2,3 \* \* 0-4/);
  assert.match(sql, /night-before-summary/);
  assert.match(sql, /send_night_before_summary/);
});

// ─── Night-before moved to 7:30 PM Pacific, DOW 1-5 ────────────

test("night-before 7:30pm: moves to 7:30 PM and extends DOW to 1-5 (Sun–Thu Pacific)", async () => {
  const sql = await readFile(moveNightBeforeTo730MigrationUrl, "utf8");

  // Unschedules the 7:45 PM / DOW 1-4 night-before cron
  assert.match(sql, /cron\.unschedule\('night-before-summary'\)/);

  // New schedule: 7:30 PM Pacific = 02:30/03:30 UTC, Sun–Thu Pacific nights
  // (DOW 1-5 in UTC = Sun–Thu Pacific, covering all 5 school mornings)
  assert.match(sql, /30 2,3 \* \* 1-5/);
  assert.match(sql, /night-before-summary/);
  assert.match(sql, /send_night_before_summary/);

  // Does NOT redefine the wrapper function — only the cron schedule changes
  assert.doesNotMatch(sql, /create or replace function/);
});

// ─── Sunday morning coordinator tentative summary email ───────────

test("coordinator_tentative_summary: send-push has the type with all-member targeting + draft roster", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // The type branch exists
  assert.match(ts, /type === "coordinator_tentative_summary"/);

  // Targets all active members (status=eq.active, no role filter)
  assert.match(ts, /status: "eq\.active"/);

  // Loads the draft schedule version (not published)
  assert.match(ts, /status: "eq\.draft"/);

  // Loads tentative + confirmed driver assignments
  assert.match(ts, /driver_assignments/);

  // Per-week + per-date idempotency key (DST-proof dedup)
  assert.match(ts, /coordinator-tentative-\$\{weekId\}-\$\{todayStr\}/);

  // Email-only — mentions the confirmation deadline
  assert.match(ts, /Parents must confirm their drives by Sunday/);

  // Tags for Resend analytics
  assert.match(ts, /coordinator_tentative_summary/);
});

test("coordinator_tentative_summary: cron migration creates wrapper function + Sunday 7 AM Pacific schedule", async () => {
  const sql = await readFile(coordinatorTentativeSummaryMigrationUrl, "utf8");

  // Creates the wrapper function
  assert.match(sql, /create or replace function public\.send_coordinator_tentative_summary/);
  assert.match(sql, /language plpgsql/);
  assert.match(sql, /security definer/);

  // Reads cron_secret + cron_edge_base_url from vault (environment-aware)
  assert.match(sql, /vault\.decrypted_secrets/);
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);

  // POSTs to /send-push with type coordinator_tentative_summary
  assert.match(sql, /'\/send-push'/);
  assert.match(sql, /'coordinator_tentative_summary'/);

  // Revokes public access
  assert.match(sql, /revoke all on function public\.send_coordinator_tentative_summary/);

  // Sunday 7 AM Pacific, DST-proofed dual UTC (14:00 and 15:00 UTC)
  assert.match(sql, /0 14,15 \* \* 0/);
  assert.match(sql, /coordinator-tentative-summary/);
});

// ─── Backpack sheet (morning-of per-child email) ───────────

test("backpack_sheet: send-push has the type with phone numbers + per-child sections", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // The type branch exists
  assert.match(ts, /type === "backpack_sheet"/);

  // Loads published schedule version + confirmed assignments
  assert.match(ts, /status: "eq\.published"/);
  assert.match(ts, /status: "eq\.confirmed"/);

  // Fetches phone from profiles (drive-scoped, always shown)
  assert.match(ts, /profiles.*phone/);

  // Has formatPhone helper
  assert.match(ts, /function formatPhone/);

  // Per-child sections (kid name + trip info)
  assert.match(ts, /backpack-sheet-\$\{today\}-\$\{profile\.id\}/);

  // Tags for Resend analytics
  assert.match(ts, /backpack_sheet/);
});

test("backpack_sheet: cron migration creates wrapper function + 7 AM Pacific Mon–Fri schedule", async () => {
  const sql = await readFile(backpackSheetMigrationUrl, "utf8");

  // Creates the wrapper function
  assert.match(sql, /create or replace function public\.send_backpack_sheet/);
  assert.match(sql, /language plpgsql/);
  assert.match(sql, /security definer/);

  // Reads cron_secret + cron_edge_base_url from vault (environment-aware)
  assert.match(sql, /vault\.decrypted_secrets/);
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);

  // POSTs to /send-push with type backpack_sheet
  assert.match(sql, /'\/send-push'/);
  assert.match(sql, /'backpack_sheet'/);

  // Revokes public access
  assert.match(sql, /revoke all on function public\.send_backpack_sheet/);

  // 7 AM Pacific Mon–Fri, DST-proofed dual UTC (14:00 and 15:00 UTC)
  assert.match(sql, /0 14,15 \* \* 1-5/);
  assert.match(sql, /backpack-sheet/);
});

test("backpack_sheet: timeout fix adds 120s pg_net timeout", async () => {
  const sql = await readFile(backpackSheetTimeoutMigrationUrl, "utf8");

  // Rewrites the wrapper function with CREATE OR REPLACE
  assert.match(sql, /create or replace function public\.send_backpack_sheet/);

  // Adds the 120s timeout
  assert.match(sql, /timeout_milliseconds := 120000/);

  // Still uses vault secrets (environment-aware)
  assert.match(sql, /cron_secret/);
  assert.match(sql, /cron_edge_base_url/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.send_backpack_sheet/);
});

test("backpack_sheet: kid phone numbers included in carmate list", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Children query includes the phone column
  assert.match(ts, /children.*phone/);

  // Kids with phones structure (name + phone per kid)
  assert.match(ts, /kidsWithPhones/);

  // Carmate phones rendered with formatPhone
  assert.match(ts, /formatPhone\(k\.phone\)/);
  assert.match(ts, /no phone/);
});

// ─── Surgical Sunday evening cron ──────────────────────────────

test("surgical_sunday: Edge Function has mode param + surgical branch", async () => {
  const ts = await readFile(generateScheduleUrl, "utf8");

  // Parses mode from body
  assert.match(ts, /mode/);

  // Has the surgical branch
  assert.match(ts, /mode === "surgical"/);

  // Surgical mode preserves confirmed assignments (doesn't run generateSchedule)
  assert.match(ts, /SchedulingOutputs/);
  assert.match(ts, /surgical/);

  // Falls back to full generation when not surgical
  assert.match(ts, /generateSchedule\(inputs\)/);
});

test("surgical_sunday: cron migration creates publish_and_update_schedule wrapper", async () => {
  const sql = await readFile(surgicalSundayCronMigrationUrl, "utf8");

  // Creates the new wrapper function
  assert.match(sql, /create or replace function public\.publish_and_update_schedule/);
  assert.match(sql, /security definer/);

  // POSTs to /generate-schedule with mode: "surgical"
  assert.match(sql, /'\/generate-schedule'/);
  assert.match(sql, /'mode', 'surgical'/);

  // Revokes public access
  assert.match(sql, /revoke all on function public\.publish_and_update_schedule/);

  // Unschedules old generate-schedule-sunday
  assert.match(sql, /cron\.unschedule\('generate-schedule-sunday'\)/);

  // Reschedules with the new wrapper at same time (8:30 PM Pacific)
  assert.match(sql, /30 3,4 \* \* 1/);
  assert.match(sql, /publish_and_update_schedule/);
});

// ─── Drive reassignment feature ────────────────────────────

test("reassignment: migration creates reassignment_requests table with correct schema", async () => {
  const sql = await readFile(reassignmentMigrationUrl, "utf8");

  // Creates the enum
  assert.match(sql, /create type public\.reassignment_status as enum/);
  assert.match(sql, /'pending', 'accepted', 'declined', 'cancelled'/);

  // Creates the table
  assert.match(sql, /create table public\.reassignment_requests/);
  assert.match(sql, /assignment_id uuid not null references public\.driver_assignments/);
  assert.match(sql, /target_profile_id uuid not null references public\.profiles/);
  assert.match(sql, /requested_by uuid not null references public\.profiles/);
  assert.match(sql, /status public\.reassignment_status not null default 'pending'/);

  // Partial unique index for one pending per assignment
  assert.match(sql, /reassignment_requests_one_pending/);
  assert.match(sql, /where status = 'pending'/);

  // RLS enabled, select-only for group members
  assert.match(sql, /alter table public\.reassignment_requests enable row level security/);
  assert.match(sql, /reassignment_requests_select_group/);
  assert.match(sql, /is_group_member/);
});

test("reassignment: 3 RPCs exist with security definer + revoked from public", async () => {
  const sql = await readFile(reassignmentMigrationUrl, "utf8");

  // request_drive_reassignment
  assert.match(sql, /create or replace function public\.request_drive_reassignment/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.request_drive_reassignment\(uuid, uuid\) from public/);
  assert.match(sql, /grant execute on function public\.request_drive_reassignment\(uuid, uuid\) to authenticated/);

  // respond_to_reassignment_request
  assert.match(sql, /create or replace function public\.respond_to_reassignment_request/);
  assert.match(sql, /revoke all on function public\.respond_to_reassignment_request\(uuid, text\) from public/);
  assert.match(sql, /grant execute on function public\.respond_to_reassignment_request\(uuid, text\) to authenticated/);

  // cancel_reassignment_request
  assert.match(sql, /create or replace function public\.cancel_reassignment_request/);
  assert.match(sql, /revoke all on function public\.cancel_reassignment_request\(uuid\) from public/);
  assert.match(sql, /grant execute on function public\.cancel_reassignment_request\(uuid\) to authenticated/);
});

test("reassignment: request RPC has all guards", async () => {
  const sql = await readFile(reassignmentMigrationUrl, "utf8");

  assert.match(sql, /auth\.uid\(\) is null/);
  assert.match(sql, /driver_profile_id <> auth\.uid\(\)/);
  assert.match(sql, /status <> 'confirmed'/);
  assert.match(sql, /p_target_profile_id = auth\.uid\(\)/);
  assert.match(sql, /status = 'active'/);
  assert.match(sql, /Cannot reassign a drive that has already departed/);
  assert.match(sql, /Target must be a parent of a child on this drive or a member of your household/);
  assert.match(sql, /child_passenger_capacity >= v_rider_count/);
});

test("reassignment: accept RPC has all acceptance-time guards", async () => {
  const sql = await readFile(reassignmentMigrationUrl, "utf8");

  assert.match(sql, /target_profile_id <> auth\.uid\(\)/);
  assert.match(sql, /status <> 'pending'/);
  assert.match(sql, /assignment\.status <> 'confirmed'/);
  assert.match(sql, /schedule has been updated/);
  assert.match(sql, /already departed/);
  assert.match(sql, /no riders remaining/);
  assert.match(sql, /no longer has enough seats/);
  assert.match(sql, /already assigned to drive this trip/);

  // Rider transfer pattern (same as volunteer_for_declined_drive)
  assert.match(sql, /set driver_assignment_id = v_new_assignment\.id/);
  assert.match(sql, /set status = 'released'/);
});

test("reassignment: audit events written for all state transitions", async () => {
  const sql = await readFile(reassignmentMigrationUrl, "utf8");

  assert.match(sql, /'reassignment_requested'/);
  assert.match(sql, /'drive_reassigned'/);
  assert.match(sql, /'reassignment_declined'/);
  assert.match(sql, /'reassignment_cancelled'/);
});

test("send-push: reassignment_requested branch notifies target", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  assert.match(ts, /type === "reassignment_requested"/);
  assert.match(ts, /reassignment_requests/);
  assert.match(ts, /carpool-reassignment-requested/);
  assert.match(ts, /sendEmailAndPush/);
});

test("send-push: reassignment_declined branch notifies original driver", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  assert.match(ts, /type === "reassignment_declined"/);
  assert.match(ts, /carpool-reassignment-declined/);
  assert.match(ts, /you're still driving/);
});

test("send-push: reassignment_accepted branch sends .ics + 3 audiences", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  assert.match(ts, /type === "reassignment_accepted"/);

  // .ics CANCEL for original driver
  assert.match(ts, /METHOD:CANCEL/);

  // .ics INVITE for target driver
  assert.match(ts, /drive-confirmed-\$\{newDa\.id\}@carpoolcrew\.co/);

  // Idempotency keys for all 3 audiences
  assert.match(ts, /carpool-reassignment-accepted-\$\{request_id\}-\$\{origDriver\.id\}/);
  assert.match(ts, /carpool-reassignment-accepted-\$\{request_id\}-\$\{targetDriver\.id\}/);
  assert.match(ts, /carpool-reassignment-accepted-\$\{request_id\}-\$\{profile\.id\}/);

  // Tags
  assert.match(ts, /value: "reassignment_accepted"/);
});

test("send-push: request_id parsed from request body", async () => {
  const ts = await readFile(sendPushUrl, "utf8");
  assert.match(ts, /request_id/);
});

// ─── Parent-initiated afternoon drive-time switch ─────────────

const switchMigrationUrl = new URL(
  "../supabase/migrations/202609010003_switch_afternoon_trip.sql",
  import.meta.url,
);

test("switch_afternoon_trip: RPC exists with security definer", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.switch_child_afternoon_trip/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.switch_child_afternoon_trip/);
  assert.match(sql, /grant execute on function public\.switch_child_afternoon_trip/);
});

test("switch_afternoon_trip: verifies household membership", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /is_household_member/);
});

test("switch_afternoon_trip: only allows afternoon trips", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /direction <> 'afternoon'/);
});

test("switch_afternoon_trip: finds sibling trip by slot", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /pm_early.*pm_late|pm_late.*pm_early/);
});

test("switch_afternoon_trip: checks capacity before insert", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /child_passenger_capacity/);
  assert.match(sql, /cars are full/);
});

test("switch_afternoon_trip: updates ride_requests", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /needs_ride = false/);
  assert.match(sql, /needs_ride = true/);
});

test("switch_afternoon_trip: writes audit event", async () => {
  const sql = await readFile(switchMigrationUrl, "utf8");
  assert.match(sql, /child_switched_afternoon_trip/);
  assert.match(sql, /audit_events/);
});

test("send-push: rider_switched_old notifies old driver", async () => {
  const ts = await readFile(sendPushUrl, "utf8");
  assert.match(ts, /type === "rider_switched_old"/);
  assert.match(ts, /carpool-rider-switched-old/);
  assert.match(ts, /was moved from your drive/);
});

test("send-push: rider_switched_new notifies new driver", async () => {
  const ts = await readFile(sendPushUrl, "utf8");
  assert.match(ts, /type === "rider_switched_new"/);
  assert.match(ts, /carpool-rider-switched-new/);
  assert.match(ts, /was added to your drive/);
});

// ─── switch_afternoon_trip version scoping (Sep 3 production bug) ──

const switchVersionScopeMigrationUrl = new URL(
  "../supabase/migrations/202609030002_switch_trip_version_scope.sql",
  import.meta.url,
);

test("switch_afternoon_trip: destination assignment scoped to the old assignment's schedule version", async () => {
  const sql = await readFile(switchVersionScopeMigrationUrl, "utf8");

  // Rewrites the RPC
  assert.match(sql, /create or replace function public\.switch_child_afternoon_trip/);
  assert.match(sql, /security definer/);

  // THE FIX: the destination search must filter by the outgoing assignment's
  // schedule_version_id. The weekly draft version coexists with the published
  // version with identically-shaped assignments; the unscoped search picked
  // the DRAFT assignment and the rider-assignment scope trigger rejected the
  // cross-version insert ('Rider assignment does not match its driver
  // assignment').
  assert.match(sql, /and schedule_version_id = v_old_assignment\.schedule_version_id/);

  // The filter must be inside the destination-assignment loop, before the
  // status filter
  assert.match(
    sql,
    /where trip_id = v_new_trip\.id\s+and group_id = v_group_id\s+and schedule_version_id = v_old_assignment\.schedule_version_id\s+and status in \('tentative', 'confirmed'\)/,
  );

  // Unchanged guards still present
  assert.match(sql, /is_household_member/);
  assert.match(sql, /cars are full/);
  assert.match(sql, /child_switched_afternoon_trip/);
  assert.match(sql, /revoke all on function public\.switch_child_afternoon_trip\(uuid, uuid\) from public/);
});