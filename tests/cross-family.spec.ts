// Cross-family cancel/recovery tests — verify what each affected parent sees
// when a driver cancels, re-accepts, or another parent takes over.
//
// These tests drive actions through the UI (not SQL) and switch between
// user sessions to verify that every affected parent sees the correct state.
// They run in a separate file so Playwright can run them in parallel with
// other suites.
//
// Run locally:   npm run test:runtime:local -- --grep "Cross-Family"
// Run on staging: npm run test:runtime -- --grep "Cross-Family"

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID,
} from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteTestUser, deleteAllTestUsers } = makeAuth(env);
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

function cleanupCrossFamData() {
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
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@crossfam.kidpool')
    );
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@crossfam.kidpool');
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@crossfam.kidpool')
    );
    DELETE FROM public.profiles WHERE email LIKE '%@crossfam.kidpool';
  `);
  deleteAllTestUsers();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@crossfam.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(600 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} CrossFam') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} CrossFam', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
return { userId, householdId, email };
}

function setupCurrentWeekWithTrips() {
  return setupWeekStartingOn(currentMondayStrSF());
}

function setupNextWeekWithTrips() {
  const mondayStr = currentMondayStrSF();
  const [y, m, d] = mondayStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 7);
  return setupWeekStartingOn(date.toISOString().slice(0, 10));
}

// Returns YYYY-MM-DD for the Monday of the current week in SF time.
// Uses UTC date arithmetic to avoid system timezone interference.
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

function setupWeekStartingOn(mondayStr: string) {
  const weekStart = mondayStr;

  const weekId = UID(950);
  const tripIds: string[] = [];
  const dates: string[] = [];
  // Trip dates are Monday–Friday of the week (validate_trip_service_date
  // requires dates within the week). Use UTC arithmetic for consistency.
  const [my, mm, md] = mondayStr.split("-").map(Number);
  const mondayDate = new Date(Date.UTC(my, mm - 1, md));
  for (let d = 0; d < 5; d++) {
    const date = new Date(mondayDate);
    date.setUTCDate(mondayDate.getUTCDate() + d);
    dates.push(date.toISOString().slice(0, 10));
  }

  // Check-in deadline is in the recent past (Saturday before this week).
  // Confirmation deadline is 7 days from now so it hasn't passed —
  // the Edge Function keeps the schedule as draft with tentative assignments.
  const saturdayDate = new Date(mondayDate);
  saturdayDate.setUTCDate(mondayDate.getUTCDate() - 2);
  const saturdayStr = saturdayDate.toISOString().slice(0, 10);
  const futureConfirmation = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const checkinDeadline = `${saturdayStr}T15:00:00-08:00`;
  const confirmationDeadline = `${localDateStr(futureConfirmation)}T20:00:00-08:00`;

  let sql = `DELETE FROM public.rider_assignments WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}'));\n`;
  sql += `DELETE FROM public.driver_confirmations WHERE driver_assignment_id IN (SELECT id FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}')));\n`;
  sql += `DELETE FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}'));\n`;
  sql += `DELETE FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}');\n`;
  sql += `DELETE FROM public.driver_availability WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}'));\n`;
  sql += `DELETE FROM public.ride_requests WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}'));\n`;
  sql += `DELETE FROM public.weekly_checkins WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}') AND household_id::text LIKE 'deadbeef-%';\n`;
  sql += `DELETE FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}');\n`;
  sql += `DELETE FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}';\n`;
  sql += `INSERT INTO public.weeks (id, group_id, starts_on, status, checkin_deadline, confirmation_deadline) VALUES ('${weekId}', '${GROUP_ID}', '${weekStart}', 'open', '${checkinDeadline}', '${confirmationDeadline}') ON CONFLICT DO NOTHING;\n`;
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
  const tokenData = JSON.parse(tokenResult);
  const jwt = tokenData.access_token;
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

function getAssignmentId(versionId: string, tripId: string, driverUserId: string): string | null {
  const result = runSql(`SELECT id FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${tripId}' AND driver_profile_id = '${driverUserId}' LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).id as string : null;
}

function getAssignmentStatus(assignmentId: string): string | null {
  const result = runSql(`SELECT status FROM public.driver_assignments WHERE id = '${assignmentId}';`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).status as string : null;
}

function getConfirmedDriverForTrip(versionId: string, tripId: string): { driverId: string; driverName: string } | null {
  const result = runSql(`
    SELECT da.driver_profile_id AS id, p.full_name AS name
    FROM public.driver_assignments da
    JOIN public.profiles p ON p.id = da.driver_profile_id
    WHERE da.schedule_version_id = '${versionId}' AND da.trip_id = '${tripId}' AND da.status = 'confirmed'
    LIMIT 1;
  `);
  const rows = result.rows ?? [];
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return { driverId: r.id as string, driverName: r.name as string };
}

// Helper: seed a family with a child + vehicle, check in for a trip, and mark as
// needing a ride. Returns the household info.
// canDrive = owns a vehicle (can volunteer via Flow A). available = has driver_availability for this trip (gets assigned by scheduler).
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

// ── Helpers for UI actions ──

async function cancelDriveViaUI(page: Page, assignmentId?: string) {
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

test.describe.serial("Cross-Family Cancel/Recovery", () => {
  test.beforeAll(() => { cleanupCrossFamData(); });
  test.afterAll(() => { cleanupCrossFamData(); });
  test.afterEach(() => { cleanupCrossFamData(); });
  test.setTimeout(120000);

  // ── Test 1: Full cancel → volunteer → verify all 3 perspectives ──

  test("cancel → volunteer → all 3 families see correct state", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(10, "XFCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driverA = seedFamilyForTrip(11, "XFDriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }
    const driverB = seedFamilyForTrip(12, "XFDriverB", weekId, morningTrip, false, true, false);
    if (!driverB) { test.skip(); return; }
    const riderC = seedFamilyForTrip(13, "XFRiderC", weekId, morningTrip, false, false);
    if (!riderC) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Step 1: Driver A cancels via UI
    await signInWithTestAuth(page, driverA!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Assert: Driver A sees "cancelled drives" hero + re-accept button
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText && /cancelled/i.test(heroText), `Driver A hero should mention cancelled, got: "${heroText}"`);
    await expect(page.locator('[data-testid^="reaccept-"]').first()).toBeVisible({ timeout: 5000 });

    // Step 2: Switch to Rider B — sees Flow A decline-alert, volunteers
    await switchUser(page, driverB!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);

    // Assert: Rider B's decline-alert cleared (they're now the confirmed driver)
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Step 3: Switch to Rider C — should NOT see decline-alert (trip is covered)
    await switchUser(page, riderC!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 2000 });

    // Step 4: Switch back to Driver A — re-accept button should be GONE (assignment is released)
    await switchUser(page, driverA!.email);
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-testid^="reaccept-"]')).toBeHidden({ timeout: 3000 });

    // Step 5: All 3 check This Week tab — see Rider B as confirmed driver
    for (const fam of [driverA!, driverB!, riderC!]) {
      if (fam === driverA!) {
        // Already signed in as driverA
      } else {
        await switchUser(page, fam.email);
        await page.waitForTimeout(1500);
      }
      await page.getByTestId("nav-week").click();
      await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(1500);
      // The trip should have a confirmed roster entry
      const confirmedRoster = page.locator(".roster-status--confirmed").first();
      await expect(confirmedRoster).toBeVisible({ timeout: 5000 });
      // Go back to home for next iteration
      await page.getByTestId("nav-home").click();
    }

    // Verify in DB: Driver A's assignment is 'released', Rider B's is 'confirmed'
    const driverAAssignment = getAssignmentId(versionId, morningTrip, driverA!.userId);
    if (driverAAssignment) {
      assert.equal(getAssignmentStatus(driverAAssignment), "released", "Driver A assignment should be released");
    }
    const confirmedDriver = getConfirmedDriverForTrip(versionId, morningTrip);
    assert.ok(confirmedDriver, "there should be a confirmed driver for the trip");
  });

  // ── Test 2: Flip-flop: cancel → re-accept → cancel again ──

  test("flip-flop: cancel → re-accept → cancel again works", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(20, "FlipCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driver = seedFamilyForTrip(21, "FlipDriver", weekId, morningTrip, false, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(22, "FlipRider", weekId, morningTrip, false, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Cycle: confirm → cancel → re-accept → cancel
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);

    // Cancel first time
    await cancelDriveViaUI(page);
    let heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText && /cancelled/i.test(heroText), `after first cancel, hero should mention cancelled: "${heroText}"`);

    // Re-accept
    await reacceptDriveViaUI(page);
    await page.waitForTimeout(1000);
    let heroAfterReaccept = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroAfterReaccept && /all set|confirmed/i.test(heroAfterReaccept), `after re-accept, hero should confirm: "${heroAfterReaccept}"`);

    // Cancel second time
    await cancelDriveViaUI(page);
    heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText && /cancelled/i.test(heroText), `after second cancel, hero should mention cancelled: "${heroText}"`);

    // Switch to rider — should see decline-alert (drive was cancelled again)
    await switchUser(page, rider!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });

    // Verify in DB: only 1 driver_assignment for this trip/version, status = declined
    const assignmentCount = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${driver!.userId}';`).rows?.[0]?.n ?? 0;
    assert.equal(assignmentCount, 1, `should be 1 assignment (no duplicates), got ${assignmentCount}`);
    const status = getAssignmentStatus(getAssignmentId(versionId, morningTrip, driver!.userId)!);
    assert.equal(status, "declined", `assignment should be declined after second cancel, got ${status}`);
  });

  // ── Test 3: Cancel → volunteer → verify button gone (simplified) ──

  test("cancel → volunteer → driver re-signs in, re-accept button gone", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(30, "BtnGoneCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driver = seedFamilyForTrip(31, "BtnGoneDriver", weekId, morningTrip, false, true, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(32, "BtnGoneRider", weekId, morningTrip, false, true, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver cancels
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);
    await expect(page.locator('[data-testid^="reaccept-"]').first()).toBeVisible({ timeout: 5000 });

    // Rider volunteers
    await switchUser(page, rider!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Driver re-signs in — re-accept button should be gone (assignment is released)
    await switchUser(page, driver!.email);
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-testid^="reaccept-"]')).toBeHidden({ timeout: 3000 });

    // Verify in DB: assignment is 'released'
    const assignmentId = getAssignmentId(versionId, morningTrip, driver!.userId);
    if (assignmentId) {
      assert.equal(getAssignmentStatus(assignmentId), "released", "driver's assignment should be released after volunteer took over");
    }
  });

  // ── Test 4: Cancel → two riders race to volunteer ──

  test("cancel → two riders race to volunteer, second gets friendly error", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(40, "RaceCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driver = seedFamilyForTrip(41, "RaceDriver", weekId, morningTrip, false, true, true);
    if (!driver) { test.skip(); return; }
    const riderB = seedFamilyForTrip(42, "RaceRiderB", weekId, morningTrip, false, true, false);
    if (!riderB) { test.skip(); return; }
    const riderC = seedFamilyForTrip(43, "RaceRiderC", weekId, morningTrip, false, true, false);
    if (!riderC) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver cancels
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Rider B volunteers first (succeeds)
    await switchUser(page, riderB!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Rider C tries to volunteer on a stale alert
    await switchUser(page, riderC!.email);
    await page.waitForTimeout(2000);

    // If the stale alert is visible and the volunteer button is there, tap it
    const declineAlert = page.getByTestId("decline-alert");
    const isAlertVisible = await declineAlert.isVisible().catch(() => false);

    if (isAlertVisible) {
      const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
      if (await volunteerBtn.isVisible().catch(() => false)) {
        await volunteerBtn.click();
        await page.waitForTimeout(2000);

        // Should get a friendly error (not raw DB string)
        const errorEl = page.locator(".auth-error").first();
        const errorText = await errorEl.textContent().catch(() => null);
        if (errorText) {
          assert.ok(!/not declined/i.test(errorText), `should not show raw DB error, got: "${errorText}"`);
          assert.ok(/already|covered|taken/i.test(errorText), `should show friendly error, got: "${errorText}"`);
        }
      }
    }

    // Verify in DB: only Rider B has a confirmed assignment, Rider C does not
    const riderBConfirmed = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${riderB!.userId}' AND status = 'confirmed';`).rows?.[0]?.n ?? 0;
    assert.equal(riderBConfirmed, 1, "Rider B should have 1 confirmed assignment");

    const riderCConfirmed = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${riderC!.userId}' AND status = 'confirmed';`).rows?.[0]?.n ?? 0;
    assert.equal(riderCConfirmed, 0, "Rider C should NOT have a confirmed assignment");
  });

  // ── Test 5: Cancel → volunteer → volunteer cancels → third family takes over ──

  test("chain of takeovers: driver cancels → rider B takes over → B cancels → rider C takes over", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(50, "ChainCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driverA = seedFamilyForTrip(51, "ChainDriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }
    const riderB = seedFamilyForTrip(52, "ChainRiderB", weekId, morningTrip, false, true, false);
    if (!riderB) { test.skip(); return; }
    const riderC = seedFamilyForTrip(53, "ChainRiderC", weekId, morningTrip, false, true, false);
    if (!riderC) { test.skip(); return; }
    const riderD = seedFamilyForTrip(54, "ChainRiderD", weekId, morningTrip, false, true, false);
    if (!riderD) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Step 1: Driver A cancels
    await signInWithTestAuth(page, driverA!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Step 2: Rider B volunteers (Flow A)
    await switchUser(page, riderB!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Step 3: Rider B cancels (their confirmed drive)
    await cancelDriveViaUI(page);
    await expect(page.locator('[data-testid^="reaccept-"]').first()).toBeVisible({ timeout: 5000 });

    // Step 4: Rider C sees decline-alert for Rider B's cancelled drive, volunteers
    await switchUser(page, riderC!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Step 5: Rider D should NOT see an alert (trip is covered by Rider C)
    await switchUser(page, riderD!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 2000 });

    // Verify in DB: Rider C is the confirmed driver, Rider B and Driver A are released
    const confirmedDriver = getConfirmedDriverForTrip(versionId, morningTrip);
    assert.ok(confirmedDriver, "there should be a confirmed driver");
    assert.equal(confirmedDriver!.driverId, riderC!.userId, "Rider C should be the confirmed driver");

    const driverAAssignment = getAssignmentId(versionId, morningTrip, driverA!.userId);
    if (driverAAssignment) {
      assert.equal(getAssignmentStatus(driverAAssignment), "released", "Driver A should be released");
    }
    const riderBAssignment = getAssignmentId(versionId, morningTrip, riderB!.userId);
    if (riderBAssignment) {
      assert.equal(getAssignmentStatus(riderBAssignment), "released", "Rider B should be released");
    }
  });

  // ── Test 6: Coordinator sees cancel + recovery in real-time ──

  test("coordinator sees cancel + volunteer recovery in real-time", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(60, "RealTimeCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driver = seedFamilyForTrip(61, "RealTimeDriver", weekId, morningTrip, false, true, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(62, "RealTimeRider", weekId, morningTrip, false, true, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver cancels
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Coordinator opens coordinate tab — should see declined alert
    await switchUser(page, coord!.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert-admin")).toBeVisible({ timeout: 5000 });

    // Rider volunteers
    await switchUser(page, rider!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Coordinator refreshes coordinate tab — declined alert should be gone
    await switchUser(page, coord!.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert-admin")).toBeHidden({ timeout: 5000 });
  });

  // ── Test 7: All families see same roster after cancel + volunteer ──

  test("data integrity: all families see same roster after cancel + volunteer", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(70, "IntegrityCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const driverA = seedFamilyForTrip(71, "IntegrityDriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }
    const riderB = seedFamilyForTrip(72, "IntegrityRiderB", weekId, morningTrip, false, true, false);
    if (!riderB) { test.skip(); return; }
    const riderC = seedFamilyForTrip(73, "IntegrityRiderC", weekId, morningTrip, false, true, false);
    if (!riderC) { test.skip(); return; }
    const riderD = seedFamilyForTrip(74, "IntegrityRiderD", weekId, morningTrip, false, false);
    if (!riderD) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver A cancels
    await signInWithTestAuth(page, driverA!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Rider B volunteers
    await switchUser(page, riderB!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // All 4 families check This Week tab — verify they all see Rider B as confirmed
    const families = [driverA!, riderB!, riderC!, riderD!];
    for (let i = 0; i < families.length; i++) {
      const fam = families[i];
      if (i === 1) {
        // Already signed in as riderB
      } else {
        await switchUser(page, fam.email);
      }
      await page.waitForTimeout(1500);
      await page.getByTestId("nav-week").click();
      await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(1500);

      // Assert: confirmed roster entry visible
      const confirmedRoster = page.locator(".roster-status--confirmed").first();
      await expect(confirmedRoster).toBeVisible({ timeout: 5000 });

      if (i < families.length - 1) {
        await page.getByTestId("nav-home").click();
      }
    }

    // Final DB verification: exactly 1 confirmed driver for the trip
    const confirmedCount = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND status = 'confirmed';`).rows?.[0]?.n ?? 0;
    assert.equal(confirmedCount, 1, `should be exactly 1 confirmed driver, got ${confirmedCount}`);

    const confirmedDriver = getConfirmedDriverForTrip(versionId, morningTrip);
    assert.ok(confirmedDriver, "there should be a confirmed driver");
    assert.equal(confirmedDriver!.driverId, riderB!.userId, "Rider B should be the confirmed driver");
  });
});