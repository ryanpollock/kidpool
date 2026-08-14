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
  "../supabase/migrations/202608130001_publish_sunday_evening.sql",
  import.meta.url,
);
const pgnetTimeoutMigrationUrl = new URL(
  "../supabase/migrations/202608130002_increase_pgnet_timeout.sql",
  import.meta.url,
);
const pgnetTimeoutRemainingMigrationUrl = new URL(
  "../supabase/migrations/202608130003_increase_pgnet_timeout_remaining.sql",
  import.meta.url,
);
const restoreReleasedMigrationUrl = new URL(
  "../supabase/migrations/202608130004_restore_released_on_volunteer_decline.sql",
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
  // by 202608130001_publish_sunday_evening.sql (tested below). This assertion
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

  // New schedule: '30 3,4 * * 1' = Mon 03:30 and 04:30 UTC
  //   Mon 03:30 UTC = Sun 8:30 PM PDT  (first fire after 8 PM PDT deadline)
  //   Mon 04:30 UTC = Sun 8:30 PM PST  (first fire after 8 PM PST deadline)
  // The off-DST fire is an idempotent no-op (generate_schedule_cron self-gates
  // on deadlinePassed && !wasPublished).
  assert.match(sql, /30 3,4 \* \* 1/);
  assert.match(sql, /generate_schedule_cron/);

  // Saturday draft cron is NOT touched by this reschedule
  assert.doesNotMatch(sql, /generate-schedule-saturday/);
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
  assert.match(ts, /deadline-reminder-\$\{new Intl\.DateTimeFormat\("en-CA", \{ timeZone: "America\/Los_Angeles"/);
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
  assert.match(ts, /Check in by Saturday 3 PM/);
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
  assert.match(tsx, /Automated at Sat 3 PM/);

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

test("send-push: night_before_summary branch sends personalized emails", async () => {
  const ts = await readFile(sendPushUrl, "utf8");

  // Branch handled with its own early-return (per-recipient custom content)
  assert.match(ts, /type === "night_before_summary"/);
  assert.match(ts, /night_before_summary: "who's driving tomorrow" email/);

  // Gates to 9–10 PM Pacific (after the 8:30 PM Sunday auto-publish)
  assert.match(ts, /pacificHour < 21 \|\| pacificHour > 22/);

  // Idempotency key is date-stamped per recipient
  assert.match(ts, /night-before-\$\{tomorrow\}-\$\{profile\.id\}/);

  // Skips all test/seed/demo emails (any address ending in "kidpool")
  assert.match(ts, /isTestEmail/);

  // Personalized driving status section + full roster
  assert.match(ts, /Tomorrow's carpool/);
  assert.match(ts, /You're driving tomorrow/);
  assert.match(ts, /You're not driving tomorrow/);
  assert.match(ts, /Tomorrow's drivers/);

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
  assert.match(ts, /75-min pre-drive email \+ push to confirmed drivers/);

  // Gates to exact Pacific minute (7:25 AM for morning, 4:00 PM for afternoon)
  assert.match(ts, /pacificHour === 7 && pacificMinute >= 25/);
  assert.match(ts, /pacificHour === 16 && pacificMinute >= 0/);

  // Only confirmed drivers (not tentative)
  assert.match(ts, /status: "eq.confirmed"/);

  // Idempotency key is per-trip-per-driver
  assert.match(ts, /drive-reminder-\$\{trip\.id\}-\$\{da\.driver_profile_id\}/);

  // Push title + email subject
  assert.match(ts, /Drive in 75 minutes/);

  // Lists kids in the car
  assert.match(ts, /Kids in your car/);

  // Skips all test/seed/demo emails (any address ending in "kidpool")
  assert.match(ts, /isTestEmail/);

  // Resend tags include the type
  assert.match(ts, /value: "drive_reminder"/);
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

// ─── Restore released assignment when volunteer declines ────

test("restore released: respond_to_driver_assignment restores released assignment on decline", async () => {
  const sql = await readFile(restoreReleasedMigrationUrl, "utf8");

  // Rewrites the RPC with CREATE OR REPLACE
  assert.match(sql, /create or replace function public\.respond_to_driver_assignment\(/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.respond_to_driver_assignment\(uuid, public\.confirmation_response, text\) from public/);

  // When declining a confirmed assignment, looks for a 'released' assignment
  // for the same trip + schedule_version
  assert.match(sql, /status = 'released'/);
  assert.match(sql, /schedule_version_id = assignment\.schedule_version_id/);
  assert.match(sql, /trip_id = assignment\.trip_id/);

  // Guards: only restores if no other confirmed/tentative driver exists
  assert.match(sql, /status in \('tentative', 'confirmed'\)/);
  assert.match(sql, /v_other_active_count = 0/);

  // Moves riders back to the restored assignment
  assert.match(sql, /update public\.rider_assignments/);
  assert.match(sql, /set driver_assignment_id = v_released_assignment\.id/);

  // Restores the released assignment to 'declined' (not 'confirmed')
  assert.match(sql, /set status = 'declined'/);
  assert.match(sql, /where id = v_released_assignment\.id/);

  // Audit event for the restoration
  assert.match(sql, /released_assignment_restored/);

  // One-time data fix block
  assert.match(sql, /one-time data fix/);
  assert.match(sql, /do \$\$/);
});

test("restore released: one-time data fix only restores when no active driver exists", async () => {
  const sql = await readFile(restoreReleasedMigrationUrl, "utf8");

  // The data fix checks for v_active_count = 0 before restoring
  assert.match(sql, /v_active_count = 0/);

  // Only matches released + declined pairs for the same trip + version
  assert.match(sql, /da_released\.status = 'released'/);
  assert.match(sql, /da_declined\.status = 'declined'/);
  assert.match(sql, /da_released\.driver_profile_id <> da_declined\.driver_profile_id/);

  // Only runs once — restored assignments become 'declined', not 'released',
  // so they won't match the WHERE clause on re-run
  assert.match(sql, /Idempotent/);
});