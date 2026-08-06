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

  // Sunday cron (after 8 PM Pacific in both DST and standard time)
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