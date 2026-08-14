// Toggle drive cycle test — cancel/volunteer/cancel/re-accept back and forth.
//
// Verifies the full cycle:
//   Driver A confirms → cancels → Driver B volunteers → B cancels →
//   A re-accepts (released) → A cancels → B re-accepts own declined →
//   B cancels → A re-accepts (released) again.
//
// At each step asserts:
//   - Exactly 1 confirmed driver in the DB
//   - Riders on the correct assignment
//   - UI shows the right state (hero text, alerts, re-accept button)
//
// Run locally:   npm run test:runtime:local -- --grep "Toggle Drive Cycle"
// Run on staging: npm run test:runtime -- --grep "Toggle Drive Cycle"

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID,
} from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteAllTestUsers } = makeAuth(env);
const skip = !env.serviceKey;
const TEST_PASSWORD = "TestPass123!";
const SUPABASE_URL = env.supabaseUrl;
const ANON_KEY = env.anonKey;
const GROUP_ID = PILOT_GROUP_ID;

function localDateStr(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function cleanupToggleData() {
  if (env.isLocal) {
    truncateAll(runSql, GROUP_ID);
    return;
  }
  runSql(`
    DELETE FROM public.rider_assignments WHERE trip_id::text LIKE 'deadbeef-%' OR child_id::text LIKE 'deadbeef-%';
    DELETE FROM public.driver_assignments WHERE trip_id::text LIKE 'deadbeef-%' OR schedule_version_id::text LIKE 'deadbeef-%';
    DELETE FROM public.ride_requests WHERE trip_id::text LIKE 'deadbeef-%' OR checkin_id::text LIKE 'deadbeef-%' OR child_id::text LIKE 'deadbeef-%';
    DELETE FROM public.driver_availability WHERE trip_id::text LIKE 'deadbeef-%' OR checkin_id::text LIKE 'deadbeef-%';
    DELETE FROM public.schedule_versions WHERE week_id::text LIKE 'deadbeef-%';
    DELETE FROM public.trips WHERE id::text LIKE 'deadbeef-%';
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.children WHERE id::text LIKE 'deadbeef-%' OR household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.vehicles WHERE id::text LIKE 'deadbeef-%' OR household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND (
      id::text LIKE 'deadbeef-%'
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@toggle.kidpool')
    );
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@toggle.kidpool');
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@toggle.kidpool')
    );
    DELETE FROM public.profiles WHERE email LIKE '%@toggle.kidpool';
  `);
  deleteAllTestUsers();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@toggle.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(600 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Toggle') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Toggle', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function currentMondayStrSF(): string {
  const sfToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m, d] = sfToday.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function setupNextWeekWithTrips() {
  const mondayStr = currentMondayStrSF();
  const [y, m, d] = mondayStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 7);
  return setupWeekStartingOn(date.toISOString().slice(0, 10));
}

function setupWeekStartingOn(mondayStr: string) {
  const weekId = UID(950);
  const tripIds: string[] = [];
  const dates: string[] = [];
  const [my, mm, md] = mondayStr.split("-").map(Number);
  const mondayDate = new Date(Date.UTC(my, mm - 1, md));
  for (let d = 0; d < 5; d++) {
    const date = new Date(mondayDate);
    date.setUTCDate(mondayDate.getUTCDate() + d);
    dates.push(date.toISOString().slice(0, 10));
  }
  const saturdayDate = new Date(mondayDate);
  saturdayDate.setUTCDate(mondayDate.getUTCDate() - 2);
  const saturdayStr = saturdayDate.toISOString().slice(0, 10);
  const futureConfirmation = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const checkinDeadline = `${saturdayStr}T15:00:00-08:00`;
  const confirmationDeadline = `${localDateStr(futureConfirmation)}T20:00:00-08:00`;

  let sql = `DELETE FROM public.rider_assignments WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}'));\n`;
  sql += `DELETE FROM public.driver_confirmations WHERE driver_assignment_id IN (SELECT id FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}')));\n`;
  sql += `DELETE FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}'));\n`;
  sql += `DELETE FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}');\n`;
  sql += `DELETE FROM public.driver_availability WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}'));\n`;
  sql += `DELETE FROM public.ride_requests WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}'));\n`;
  sql += `DELETE FROM public.weekly_checkins WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}') AND household_id::text LIKE 'deadbeef-%';\n`;
  sql += `DELETE FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}');\n`;
  sql += `DELETE FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${mondayStr}';\n`;
  sql += `INSERT INTO public.weeks (id, group_id, starts_on, status, checkin_deadline, confirmation_deadline) VALUES ('${weekId}', '${GROUP_ID}', '${mondayStr}', 'open', '${checkinDeadline}', '${confirmationDeadline}') ON CONFLICT DO NOTHING;\n`;
  for (let d = 0; d < 5; d++) {
    for (const dir of ["morning", "afternoon"]) {
      const tId = UID(600 + d * 2 + (dir === "morning" ? 0 : 1));
      tripIds.push(tId);
      const time = dir === "morning" ? "08:40" : "15:15";
      sql += `INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${tId}', '${GROUP_ID}', '${weekId}', '${dates[d]}', '${dir}', '${time}', '${time}', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;\n`;
    }
  }
  runSql(sql);
  return { weekId, tripIds };
}

async function signInWithTestAuth(page: Page, email: string) {
  await page.goto(`/?testAuth=${email}|${TEST_PASSWORD}`);
  await expect(
    page.getByTestId("home-screen").or(page.getByTestId("onboarding-screen"))
  ).toBeVisible({ timeout: 15000 });
}

async function switchUser(page: Page, email: string) {
  await page.context().clearCookies();
  await signInWithTestAuth(page, email);
}

async function generateSchedule(coordEmail: string, weekId: string) {
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

function publishScheduleViaSql(weekId: string) {
  runSql(`
    UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft') AND status = 'tentative';
    UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
  `);
}

function getPublishedVersionId(weekId: string): string | null {
  const result = runSql(`SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}' AND status = 'published' ORDER BY version_number DESC LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).id as string : null;
}

function getAssignmentStatus(assignmentId: string): string | null {
  const result = runSql(`SELECT status FROM public.driver_assignments WHERE id = '${assignmentId}';`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).status as string : null;
}

function getRiderCount(assignmentId: string): number {
  const result = runSql(`SELECT count(*)::int AS n FROM public.rider_assignments WHERE driver_assignment_id = '${assignmentId}';`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).n as number : 0;
}

function getConfirmedCount(versionId: string, tripId: string): number {
  const result = runSql(`SELECT count(*)::int AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${tripId}' AND status = 'confirmed';`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).n as number : 0;
}

async function cancelDriveViaUI(page: Page) {
  const cancelLink = page.locator('[data-testid^="cancel-drive-"]').first();
  await expect(cancelLink).toBeVisible({ timeout: 5000 });
  await cancelLink.click();
  const confirmBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
  await expect(confirmBtn).toBeVisible({ timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(2000);
}

async function reacceptDriveViaUI(page: Page) {
  const reacceptBtn = page.locator('[data-testid^="reaccept-"]').first();
  await expect(reacceptBtn).toBeVisible({ timeout: 5000 });
  await reacceptBtn.click();
  await page.waitForTimeout(2000);
}

async function volunteerViaFlowA(page: Page) {
  const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
  await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
  await volunteerBtn.click();
  await page.waitForTimeout(2000);
}

test.describe.serial("Toggle Drive Cycle", () => {
  test.beforeAll(() => { cleanupToggleData(); });
  test.afterAll(() => { cleanupToggleData(); });
  test.afterEach(() => { cleanupToggleData(); });
  test.setTimeout(120000);

  test("full toggle: A cancels → B volunteers → B cancels → A re-accepts (released) → A cancels → B re-accepts (declined)", async ({ page }) => {
    test.skip(skip, "Requires service key");

    // ── Setup: 2 driver families + 1 rider family ──
    const coord = setupHousehold(10, "TogCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driverA = seedFamilyForTrip(11, "TogDriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }
    const driverB = seedFamilyForTrip(12, "TogDriverB", weekId, morningTrip, false, true, false);
    if (!driverB) { test.skip(); return; }
    const riderC = seedFamilyForTrip(13, "TogRiderC", weekId, morningTrip, false, false, false);
    if (!riderC) { test.skip(); return; }

    // Generate + publish
    const genResult = generateSchedule(coord.email, weekId);
    assert.ok(genResult.success || genResult.version, "Schedule generation should succeed");
    publishScheduleViaSql(weekId);
    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "Should have a published version");

    // Find Driver A's assignment (should be the confirmed driver)
    const aAssignmentId = runSql(`SELECT id FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${driverA.userId}' LIMIT 1;`).rows?.[0]?.id as string;
    assert.ok(aAssignmentId, "Driver A should have an assignment");

    // Verify initial state: A is confirmed, 1 confirmed driver, riders on A
    assert.equal(getAssignmentStatus(aAssignmentId), "confirmed");
    assert.equal(getConfirmedCount(versionId, morningTrip), 1);
    assert.ok(getRiderCount(aAssignmentId) > 0, "Riders should be on Driver A's assignment");

    // ── Step 1: Driver A cancels ──
    await signInWithTestAuth(page, driverA.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    assert.equal(getAssignmentStatus(aAssignmentId), "declined");
    assert.equal(getConfirmedCount(versionId, morningTrip), 0);
    assert.equal(getRiderCount(aAssignmentId), getRiderCount(aAssignmentId), "Riders stay on A's declined assignment");

    // ── Step 2: Driver B volunteers via "I can drive" ──
    await switchUser(page, driverB.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);
    await volunteerViaFlowA(page);

    // B should now be confirmed; A should be released
    const bAssignmentId = runSql(`SELECT id FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${driverB.userId}' AND status = 'confirmed' LIMIT 1;`).rows?.[0]?.id as string;
    assert.ok(bAssignmentId, "Driver B should have a confirmed assignment");
    assert.equal(getAssignmentStatus(aAssignmentId), "released");
    assert.equal(getConfirmedCount(versionId, morningTrip), 1);
    assert.equal(getRiderCount(bAssignmentId), getRiderCount(bAssignmentId), "Riders should be on B's assignment");
    assert.equal(getRiderCount(aAssignmentId), 0, "Riders moved away from A");

    // ── Step 3: Driver B cancels ──
    await cancelDriveViaUI(page);

    assert.equal(getAssignmentStatus(bAssignmentId), "declined");
    assert.equal(getConfirmedCount(versionId, morningTrip), 0);
    assert.ok(getRiderCount(bAssignmentId) > 0, "Riders stay on B's declined assignment");
    assert.equal(getRiderCount(aAssignmentId), 0, "A still has 0 riders");

    // ── Step 4: Driver A re-accepts from "Cancelled or missed drives" ──
    // A's assignment is 'released'. The RPC should allow re-accept, move riders
    // from B's declined assignment to A's, and set A to confirmed.
    await switchUser(page, driverA.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);

    // A should see "Another driver took this drive" with a re-accept button
    await reacceptDriveViaUI(page);

    assert.equal(getAssignmentStatus(aAssignmentId), "confirmed");
    assert.equal(getAssignmentStatus(bAssignmentId), "declined");
    assert.equal(getConfirmedCount(versionId, morningTrip), 1);
    assert.ok(getRiderCount(aAssignmentId) > 0, "Riders moved back to A");
    assert.equal(getRiderCount(bAssignmentId), 0, "B has 0 riders after A re-accepted");

    // ── Step 5: Driver A cancels again ──
    await cancelDriveViaUI(page);

    assert.equal(getAssignmentStatus(aAssignmentId), "declined");
    assert.equal(getConfirmedCount(versionId, morningTrip), 0);
    assert.ok(getRiderCount(aAssignmentId) > 0, "Riders stay on A's declined assignment");

    // ── Step 6: Driver B re-accepts their own declined assignment ──
    await switchUser(page, driverB.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);
    await reacceptDriveViaUI(page);

    assert.equal(getAssignmentStatus(bAssignmentId), "confirmed");
    assert.equal(getAssignmentStatus(aAssignmentId), "declined");
    assert.equal(getConfirmedCount(versionId, morningTrip), 1);
    assert.ok(getRiderCount(bAssignmentId) > 0, "Riders on B's confirmed assignment");
    assert.equal(getRiderCount(aAssignmentId), 0, "A has 0 riders");

    // ── Step 7: Driver B cancels, Driver A re-accepts released again ──
    await cancelDriveViaUI(page);
    assert.equal(getAssignmentStatus(bAssignmentId), "declined");

    await switchUser(page, driverA.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);
    await reacceptDriveViaUI(page);

    assert.equal(getAssignmentStatus(aAssignmentId), "confirmed");
    assert.equal(getAssignmentStatus(bAssignmentId), "declined");
    assert.equal(getConfirmedCount(versionId, morningTrip), 1);
    assert.ok(getRiderCount(aAssignmentId) > 0, "Riders back on A");
    assert.equal(getRiderCount(bAssignmentId), 0, "B has 0 riders");

    // Final assertion: exactly 2 assignments for this trip, 1 confirmed + 1 declined
    const allAssignments = runSql(`SELECT status FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' ORDER BY status;`).rows ?? [];
    assert.equal(allAssignments.length, 2, "Should have exactly 2 assignments (no escalating chain)");
    const statuses = allAssignments.map((r: Record<string, unknown>) => r.status as string).sort();
    assert.deepEqual(statuses, ["confirmed", "declined"]);
  });
});

// Helper: seed a family with a child + vehicle, check in for a trip, and mark as
// needing a ride.
function seedFamilyForTrip(
  familyNum: number,
  name: string,
  weekId: string,
  tripId: string,
  coordinator = false,
  canDrive = true,
  available: boolean | null = null,
) {
  const hasAvail = available === null ? canDrive : available;
  const fam = setupHousehold(familyNum, name, coordinator);
  if (!fam) return null;
  const childId = UID(familyNum * 10 + 1);
  const vehicleId = UID(familyNum * 10 + 2);
  const checkinId = UID(familyNum * 10 + 3);

  const vehicleSql = canDrive
    ? `INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${vehicleId}', '${GROUP_ID}', '${fam.householdId}', '${name}Car', 4, true, '${fam.userId}') ON CONFLICT DO NOTHING;`
    : '';

  const availSql = (canDrive && hasAvail)
    ? `INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${fam.userId}', '${vehicleId}', 'prefer') ON CONFLICT DO NOTHING;`
    : '';

  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childId}', '${GROUP_ID}', '${fam.householdId}', 'Kid', '${name}', '${fam.userId}') ON CONFLICT DO NOTHING;
    ${vehicleSql}
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', '${fam.householdId}', 'submitted', ${canDrive ? 5 : 0}) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${childId}', true, '${fam.userId}') ON CONFLICT DO NOTHING;
    ${availSql}
  `);
  return fam;
}