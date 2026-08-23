// E2E tests for the drive reassignment feature.
// Tests the full flow: driver requests reassignment → target sees alert →
// target accepts → drive transfers. Also tests decline and cancel flows.
//
// Run locally:   npm run test:runtime:local -- --grep "Reassignment"
// Run on staging: npm run test:runtime -- --grep "Reassignment"

import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID, TEST_PASSWORD, signInWithTestAuth,
} from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteAllTestUsers } = makeAuth(env);
const skip = !env.serviceKey;

const SUPABASE_URL = env.supabaseUrl;
const ANON_KEY = env.anonKey;
const GROUP_ID = PILOT_GROUP_ID;

// ── Date helpers ──────────────────────────────────────────────────

function nextMondayStrSF(): string {
  const sfToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m, d] = sfToday.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  date.setUTCDate(date.getUTCDate() - daysBack);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function localDateStr(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// ── Setup helpers ─────────────────────────────────────────────────

interface Household {
  userId: string;
  householdId: string;
  email: string;
}

function setupHousehold(n: number, name: string, coordinator = false): Household | null {
  const email = `reassign-${name.toLowerCase()}@test.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(300 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Reassign') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Reassign', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function generateSchedule(coordEmail: string, weekId: string): { success: boolean } {
  const tokenBody = JSON.stringify({ email: coordEmail, password: TEST_PASSWORD });
  const tokenResult = execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '${tokenBody}' "${SUPABASE_URL}/auth/v1/token?grant_type=password"`,
    { encoding: "utf8" },
  );
  const jwt = JSON.parse(tokenResult).access_token;
  const fnResult = execSync(
    `curl -s -X POST -H "Authorization: Bearer ${jwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(fnResult);
}

function publishScheduleViaSql(weekId: string): void {
  runSql(`
    UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft') AND status = 'tentative';
    UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
  `);
}

function getAssignmentByDriver(weekId: string, driverProfileId: string): { id: string; status: string; trip_id: string } | null {
  const result = runSql(`
    SELECT da.id, da.status, da.trip_id
    FROM public.driver_assignments da
    JOIN public.schedule_versions sv ON sv.id = da.schedule_version_id
    WHERE sv.week_id = '${weekId}' AND da.driver_profile_id = '${driverProfileId}'
    LIMIT 1;
  `);
  const rows = result.rows ?? [];
  if (rows.length === 0) return null;
  return rows[0] as { id: string; status: string; trip_id: string };
}

function getReassignmentRequest(assignmentId: string): { id: string; status: string; target_profile_id: string } | null {
  const result = runSql(`
    SELECT id, status, target_profile_id
    FROM public.reassignment_requests
    WHERE assignment_id = '${assignmentId}'
    ORDER BY created_at DESC
    LIMIT 1;
  `);
  const rows = result.rows ?? [];
  if (rows.length === 0) return null;
  return rows[0] as { id: string; status: string; target_profile_id: string };
}

// ── Cleanup ───────────────────────────────────────────────────────

function cleanupReassignmentData(): void {
  if (env.isLocal) {
    truncateAll(runSql, GROUP_ID);
  } else {
    runSql(`
      DELETE FROM public.reassignment_requests WHERE group_id = '${GROUP_ID}' AND assignment_id::text LIKE 'deadbeef-%';
      DELETE FROM public.rider_assignments WHERE trip_id::text LIKE 'deadbeef-%' OR child_id::text LIKE 'deadbeef-%';
      DELETE FROM public.driver_confirmations WHERE driver_assignment_id::text LIKE 'deadbeef-%';
      DELETE FROM public.driver_assignments WHERE trip_id::text LIKE 'deadbeef-%' OR schedule_version_id::text LIKE 'deadbeef-%';
      DELETE FROM public.ride_requests WHERE trip_id::text LIKE 'deadbeef-%' OR checkin_id::text LIKE 'deadbeef-%' OR child_id::text LIKE 'deadbeef-%';
      DELETE FROM public.driver_availability WHERE trip_id::text LIKE 'deadbeef-%' OR checkin_id::text LIKE 'deadbeef-%';
      DELETE FROM public.schedule_versions WHERE week_id::text LIKE 'deadbeef-%';
      DELETE FROM public.trips WHERE id::text LIKE 'deadbeef-%';
      DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
      DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';
      DELETE FROM public.children WHERE id::text LIKE 'deadbeef-%' OR household_id::text LIKE 'deadbeef-%';
      DELETE FROM public.vehicles WHERE id::text LIKE 'deadbeef-%' OR household_id::text LIKE 'deadbeef-%';
      DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id::text LIKE 'deadbeef-%';
      DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND entity_id::text LIKE 'deadbeef-%';
      DELETE FROM public.profiles WHERE email LIKE '%@test.kidpool';
    `);
  }
  deleteAllTestUsers();
}

// ── Module-level state ────────────────────────────────────────────

let driverEmail = "";
let targetEmail = "";
let coordEmail = "";
let driverUserId = "";
let targetUserId = "";
let driverHouseholdId = "";
let targetHouseholdId = "";
let driverAssignmentId = "";
let weekId = "";
let driverChildId = "";
let targetChildId = "";
let setupReady = false;

// ── Tests ─────────────────────────────────────────────────────────

test.describe.serial("Reassignment", () => {
  test.beforeAll(() => {
    cleanupReassignmentData();

    const coord = setupHousehold(0, "ReassignCoord", true);
    if (!coord) return;
    const driver = setupHousehold(1, "ReassignDriver", false);
    if (!driver) return;
    const target = setupHousehold(2, "ReassignTarget", false);
    if (!target) return;

    coordEmail = coord.email;
    driverEmail = driver.email;
    targetEmail = target.email;
    driverUserId = driver.userId;
    targetUserId = target.userId;
    driverHouseholdId = driver.householdId;
    targetHouseholdId = target.householdId;

    driverChildId = UID(330);
    targetChildId = UID(331);

    // Driver's child + vehicle (4 seats)
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${driverChildId}', '${GROUP_ID}', '${driverHouseholdId}', 'Dana', 'Reassign', '${driverUserId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(340)}', '${GROUP_ID}', '${driverHouseholdId}', 'Honda', 4, true, '${driverUserId}') ON CONFLICT DO NOTHING;
    `);

    // Target's child + vehicle (4 seats — enough for 2 kids)
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${targetChildId}', '${GROUP_ID}', '${targetHouseholdId}', 'Sam', 'Reassign', '${targetUserId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(341)}', '${GROUP_ID}', '${targetHouseholdId}', 'Toyota', 4, true, '${targetUserId}') ON CONFLICT DO NOTHING;
    `);

    // Set up next week with 1 morning trip per weekday
    const mondayStr = nextMondayStrSF();
    weekId = UID(350);
    const [my, mm, md] = mondayStr.split("-").map(Number);
    const mondayDate = new Date(Date.UTC(my, mm - 1, md));
    const saturdayDate = new Date(mondayDate);
    saturdayDate.setUTCDate(mondayDate.getUTCDate() - 2);
    const saturdayStr = saturdayDate.toISOString().slice(0, 10);
    const futureConfirmation = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const checkinDeadline = `${saturdayStr}T15:00:00-08:00`;
    const confirmationDeadline = `${localDateStr(futureConfirmation)}T20:00:00-08:00`;

    let sql = `INSERT INTO public.weeks (id, group_id, starts_on, status, checkin_deadline, confirmation_deadline) VALUES ('${weekId}', '${GROUP_ID}', '${mondayStr}', 'open', '${checkinDeadline}', '${confirmationDeadline}') ON CONFLICT DO NOTHING;\n`;

    const tripDate = mondayStr;
    const amTripId = UID(351);
    sql += `INSERT INTO public.trips (id, group_id, week_id, service_date, direction, slot, meeting_time, departure_time, origin, destination) VALUES ('${amTripId}', '${GROUP_ID}', '${weekId}', '${tripDate}', 'morning', 'am', '08:40', '08:45', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;\n`;

    runSql(sql);

    // Submit check-ins for both households
    const driverCheckinId = UID(360);
    const targetCheckinId = UID(361);
    runSql(`
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${driverCheckinId}', '${GROUP_ID}', '${weekId}', '${driverHouseholdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${targetCheckinId}', '${GROUP_ID}', '${weekId}', '${targetHouseholdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${driverCheckinId}', '${amTripId}', '${driverChildId}', true, '${driverUserId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${targetCheckinId}', '${amTripId}', '${targetChildId}', true, '${targetUserId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${driverCheckinId}', '${amTripId}', '${driverUserId}', '${UID(340)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    // Generate + publish the schedule via direct SQL (bypassing Edge Function for reliability)
    const versionId = UID(355);
    const vehicleId = UID(340);
    runSql(`
      INSERT INTO public.schedule_versions (id, group_id, week_id, version_number, status, generated_by, generated_at, published_at)
      VALUES ('${versionId}', '${GROUP_ID}', '${weekId}', 1, 'published', '${driverUserId}', now(), now()) ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_assignments (id, group_id, schedule_version_id, trip_id, driver_profile_id, vehicle_id, status, child_passenger_capacity)
      VALUES ('${UID(356)}', '${GROUP_ID}', '${versionId}', '${amTripId}', '${driverUserId}', '${vehicleId}', 'confirmed', 4) ON CONFLICT DO NOTHING;
      INSERT INTO public.rider_assignments (id, group_id, schedule_version_id, trip_id, driver_assignment_id, child_id)
      VALUES ('${UID(357)}', '${GROUP_ID}', '${versionId}', '${amTripId}', '${UID(356)}', '${driverChildId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.rider_assignments (id, group_id, schedule_version_id, trip_id, driver_assignment_id, child_id)
      VALUES ('${UID(358)}', '${GROUP_ID}', '${versionId}', '${amTripId}', '${UID(356)}', '${targetChildId}') ON CONFLICT DO NOTHING;
    `);

    // Verify the driver has a confirmed assignment
    const assignment = getAssignmentByDriver(weekId, driverUserId);
    if (!assignment) return;
    driverAssignmentId = assignment.id;

    setupReady = true;
  });

  test.afterAll(() => { cleanupReassignmentData(); });
  test.setTimeout(90000);

  // ── R1: DriveDetailScreen shows "Reassign this drive" button ──

  test("R1: DriveDetailScreen shows reassign button for confirmed driver", async ({ page }) => {
    test.skip(skip || !setupReady, "Requires service key and successful setup");

    await signInWithTestAuth(page, driverEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    // The drive renders as a DriveCard on the home screen with a "Drive details" button
    const driveDetails = page.getByText("Drive details").first();
    await expect(driveDetails).toBeVisible({ timeout: 15000 });
    await driveDetails.click();

    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("reassign-drive-button")).toBeVisible({ timeout: 5000 });
  });

  // ── R2: ReassignmentPickerScreen shows eligible parents ──────

  test("R2: ReassignmentPickerScreen shows eligible target parent", async ({ page }) => {
    test.skip(skip || !setupReady, "Requires service key and successful setup");

    await signInWithTestAuth(page, driverEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const driveDetails = page.getByText("Drive details").first();
    await expect(driveDetails).toBeVisible({ timeout: 15000 });
    await driveDetails.click();
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("reassign-drive-button").click();
    await expect(page.getByTestId("reassignment-picker")).toBeVisible({ timeout: 5000 });

    const targetButton = page.getByTestId(/request-reassign-/).first();
    await expect(targetButton).toBeVisible({ timeout: 5000 });
  });

  // ── R3: Full accept flow — request → target accepts → drive transfers ──

  test("R3: Full accept flow — request, target accepts, drive transfers", async ({ page }) => {
    test.skip(skip || !setupReady, "Requires service key and successful setup");

    // Step 1: Driver requests reassignment
    await signInWithTestAuth(page, driverEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const driveDetails = page.getByText("Drive details").first();
    await expect(driveDetails).toBeVisible({ timeout: 15000 });
    await driveDetails.click();
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("reassign-drive-button").click();
    await expect(page.getByTestId("reassignment-picker")).toBeVisible({ timeout: 5000 });

    const requestButton = page.getByTestId(/request-reassign-/).first();
    await expect(requestButton).toBeVisible({ timeout: 5000 });
    await requestButton.click();

    await page.waitForTimeout(3000);

    // Verify via SQL: reassignment_requests has a pending row
    const req = getReassignmentRequest(driverAssignmentId);
    assert.ok(req, "Reassignment request should exist");
    assert.equal(req.status, "pending", "Request should be pending");

    // Step 2: Sign in as target, verify alert on home screen
    await page.goto("/");
    await signInWithTestAuth(page, targetEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    // The reassignment alert should be visible on the home screen
    await expect(page.getByTestId("reassignment-alert")).toBeVisible({ timeout: 15000 });

    // Click Accept
    const acceptButton = page.getByTestId(/reassignment-accept-/).first();
    await expect(acceptButton).toBeVisible({ timeout: 5000 });
    await acceptButton.click();

    await page.waitForTimeout(3000);

    // Step 3: Verify via SQL — original assignment is 'released', new assignment is 'confirmed'
    const origAssignment = getAssignmentByDriver(weekId, driverUserId);
    assert.ok(origAssignment, "Original assignment should still exist");
    assert.equal(origAssignment.status, "released", "Original assignment should be 'released'");

    const newAssignment = getAssignmentByDriver(weekId, targetUserId);
    assert.ok(newAssignment, "Target should have a new assignment");
    assert.equal(newAssignment.status, "confirmed", "Target's assignment should be 'confirmed'");

    // Verify reassignment request status is 'accepted'
    const reqAfter = getReassignmentRequest(driverAssignmentId);
    assert.ok(reqAfter, "Reassignment request should still exist");
    assert.equal(reqAfter.status, "accepted", "Request should be 'accepted'");
  });

  // ── R4: Decline flow — target declines, original driver keeps drive ──
  // (Separate test with fresh setup to avoid interference with R3)

  test("R4: Decline flow — request, target declines, original keeps drive", async ({ page }) => {
    test.skip(skip || !setupReady, "Requires service key and successful setup");

    // After R3, the original assignment is 'released'. Reset it to 'confirmed'
    // and clean up R3's side effects so we can test the decline flow.
    runSql(`
      DELETE FROM public.reassignment_requests WHERE assignment_id = '${driverAssignmentId}';
      DELETE FROM public.rider_assignments WHERE driver_assignment_id IN (
        SELECT id FROM public.driver_assignments WHERE driver_profile_id = '${targetUserId}' AND schedule_version_id IN (
          SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}'
        )
      );
      DELETE FROM public.driver_assignments WHERE driver_profile_id = '${targetUserId}' AND schedule_version_id IN (
        SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}'
      );
      UPDATE public.driver_assignments SET status = 'confirmed' WHERE id = '${driverAssignmentId}';
      INSERT INTO public.rider_assignments (id, group_id, schedule_version_id, trip_id, driver_assignment_id, child_id)
      VALUES ('${UID(372)}', '${GROUP_ID}', (SELECT schedule_version_id FROM driver_assignments WHERE id = '${driverAssignmentId}'), (SELECT trip_id FROM driver_assignments WHERE id = '${driverAssignmentId}'), '${driverAssignmentId}', '${driverChildId}')
      ON CONFLICT DO NOTHING;
      INSERT INTO public.rider_assignments (id, group_id, schedule_version_id, trip_id, driver_assignment_id, child_id)
      VALUES ('${UID(373)}', '${GROUP_ID}', (SELECT schedule_version_id FROM driver_assignments WHERE id = '${driverAssignmentId}'), (SELECT trip_id FROM driver_assignments WHERE id = '${driverAssignmentId}'), '${driverAssignmentId}', '${targetChildId}')
      ON CONFLICT DO NOTHING;
    `);

    // Step 1: Driver requests reassignment
    await signInWithTestAuth(page, driverEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const driveDetails = page.getByText("Drive details").first();
    await expect(driveDetails).toBeVisible({ timeout: 15000 });
    await driveDetails.click();
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("reassign-drive-button").click();
    await expect(page.getByTestId("reassignment-picker")).toBeVisible({ timeout: 5000 });

    const requestButton = page.getByTestId(/request-reassign-/).first();
    await expect(requestButton).toBeVisible({ timeout: 5000 });
    await requestButton.click();

    await page.waitForTimeout(3000);

    // Verify request is pending
    const req = getReassignmentRequest(driverAssignmentId);
    assert.ok(req, "Reassignment request should exist");
    assert.equal(req.status, "pending", "Request should be pending");

    // Step 2: Sign in as target, decline
    await page.goto("/");
    await signInWithTestAuth(page, targetEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    await expect(page.getByTestId("reassignment-alert")).toBeVisible({ timeout: 15000 });

    const declineButton = page.getByTestId(/reassignment-decline-/).first();
    await expect(declineButton).toBeVisible({ timeout: 5000 });
    await declineButton.click();

    await page.waitForTimeout(3000);

    // Step 3: Verify — original assignment still 'confirmed'
    const origAfter = getAssignmentByDriver(weekId, driverUserId);
    assert.ok(origAfter, "Original assignment should still exist");
    assert.equal(origAfter.status, "confirmed", "Original assignment should still be 'confirmed' after decline");

    // Verify request status is 'declined'
    const reqAfter = getReassignmentRequest(driverAssignmentId);
    assert.ok(reqAfter, "Reassignment request should still exist");
    assert.equal(reqAfter.status, "declined", "Request should be 'declined'");
  });

  // ── R5: Cancel flow — driver cancels a pending request ────────

  test("R5: Cancel flow — driver cancels pending request", async ({ page }) => {
    test.skip(skip || !setupReady, "Requires service key and successful setup");

    // After R4, the original assignment is still 'confirmed'. Clean up R4's
    // declined request so we can test the cancel flow.
    runSql(`DELETE FROM public.reassignment_requests WHERE assignment_id = '${driverAssignmentId}';`);

    // Driver requests reassignment
    await signInWithTestAuth(page, driverEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const driveDetails = page.getByText("Drive details").first();
    await expect(driveDetails).toBeVisible({ timeout: 15000 });
    await driveDetails.click();
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("reassign-drive-button").click();
    await expect(page.getByTestId("reassignment-picker")).toBeVisible({ timeout: 5000 });

    const requestButton = page.getByTestId(/request-reassign-/).first();
    await requestButton.click();
    await page.waitForTimeout(3000);

    // Verify pending
    const req = getReassignmentRequest(driverAssignmentId);
    assert.ok(req, "Reassignment request should exist");
    assert.equal(req.status, "pending", "Request should be pending");

    // Go back to drive detail — should show pending state with cancel button
    await page.goto("/");
    await signInWithTestAuth(page, driverEmail);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const driveDetails2 = page.getByText("Drive details").first();
    await expect(driveDetails2).toBeVisible({ timeout: 15000 });
    await driveDetails2.click();
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 10000 });

    // Should show pending state
    await expect(page.getByTestId("reassignment-pending")).toBeVisible({ timeout: 15000 });

    // Click cancel
    await page.getByTestId("cancel-reassignment").click();
    await page.waitForTimeout(2000);

    // Verify request is cancelled
    const reqAfter = getReassignmentRequest(driverAssignmentId);
    assert.ok(reqAfter, "Reassignment request should still exist");
    assert.equal(reqAfter.status, "cancelled", "Request should be 'cancelled'");

    // Verify reassign button is available again (no pending)
    await expect(page.getByTestId("reassign-drive-button")).toBeVisible({ timeout: 5000 });
  });
});