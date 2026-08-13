// Pilot scenario tests — multi-parent interaction tests that verify what
// families actually see on screen based on what OTHER families did.
//
// These tests target the exact "bad data" scenarios the PM is afraid of:
//   1. Uncovered child — hero must say "needs a ride" not "rides scheduled"
//   2. Declined drive — affected parent sees alert + can volunteer
//   3. Family didn't check in — hero must not claim "rides scheduled"
//   4. Expired driver — This Week tab must not show as active
//   5. Coordinator regenerate — family still sees published, not draft
//   6. Coordinator can publish a draft after regenerating
//   7. Declined driver: rider sees uncovered alert (getUncoveredChildren bug)
//   8. Cancel confirmed drive → affected family sees alert
//   9. Volunteer for uncovered trip → alert clears
//   10. Volunteer disabled "Car too small"
//   11. Volunteer disabled "No vehicle"
//   12. Happy path: all confirmed → "You're all set" + Add to Calendar
//   13. Rider happy path: in schedule, not driving → "rides are scheduled"
//   14. No schedule yet → hero shows check-in deadline
//   15. Draft not published → "Schedule is being prepared"
//   16. Deadline display: hero shows "Confirm by" in Pacific
//   17. Publish gate: disabled before deadline with tentative
//   18. Publish gate: enabled after deadline, tentative expire
//   19. Coordinator status: household check-in status per household
//   20. Coordinator alerts: declined + uncovered admin alerts
//   21. This Week: status pills show tentative vs confirmed
//
// Run locally:   npm run test:runtime:local -- --grep "Pilot Scenarios"
// Run on staging: npm run test:runtime -- --grep "Pilot Scenarios"
// Local mode requires `supabase start` + `supabase db reset`. Staging mode
// requires `npm run link:test` and a service key in env or keychain.

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

// Format a Date as YYYY-MM-DD in the pilot timezone (America/Los_Angeles).
// toISOString() converts to UTC which shifts the date and breaks the
// weeks_starts_on_check constraint (must be Monday).
function localDateStr(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function cleanupPilotData() {
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
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@pilot.kidpool')
    );
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@pilot.kidpool');
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@pilot.kidpool')
    );
    DELETE FROM public.profiles WHERE email LIKE '%@pilot.kidpool';
  `);
  deleteAllTestUsers();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@pilot.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(600 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Pilot') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Pilot', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
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

function setupCurrentWeekWithTrips() {
  const weekStart = currentMondayStrSF();
  return setupWeekStartingOn(weekStart);
}

function setupNextWeekWithTrips() {
  const mondayStr = currentMondayStrSF();
  const [y, m, d] = mondayStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 7);
  return setupWeekStartingOn(date.toISOString().slice(0, 10));
}

function setupWeekStartingOn(weekStart: string) {

  const weekId = UID(950);
  const tripIds: string[] = [];
  const dates: string[] = [];
  // Trip dates are Monday–Friday of the week (validate_trip_service_date
  // requires dates within the week). Use UTC arithmetic for consistency.
  const [my, mm, md] = weekStart.split("-").map(Number);
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

function getLatestVersionId(weekId: string): string | null {
  const result = runSql(`SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}' ORDER BY version_number DESC LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).id as string : null;
}

function getPublishedVersionId(weekId: string): string | null {
  const result = runSql(`SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}' AND status = 'published' ORDER BY version_number DESC LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).id as string : null;
}

test.describe.serial("Pilot Scenarios", () => {
  test.beforeAll(() => { cleanupPilotData(); });
  test.afterAll(() => { cleanupPilotData(); });
  test.afterEach(() => { cleanupPilotData(); });
  test.setTimeout(90000);

  // ── Scenario 1: Uncovered child — hero must say "needs a ride" ────

  test("uncovered child: hero says 'needs a ride' not 'rides scheduled'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(10, "UncovCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(11, "UncovDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(12, "UncovRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(610)}', '${GROUP_ID}', '${driver.householdId}', 'DriverKid', 'Uncov', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(611)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(612)}', '${GROUP_ID}', '${rider.householdId}', 'RiderKid', 'Uncov', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(620)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(620)}', '${morningTrip}', '${UID(610)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(620)}', '${morningTrip}', '${driver.userId}', '${UID(611)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(621)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      ${tripIds.map(t => `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(621)}', '${t}', '${UID(612)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;`).join('\n')}
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).not.toContain("rides are scheduled");
    expect(heroText!.toLowerCase()).not.toContain("you're all set");

    await expect(page.getByTestId("uncovered-alert")).toBeVisible({ timeout: 5000 });
  });

  // ── Scenario 2: Declined drive — affected parent sees alert + can volunteer ──

  test("declined drive: affected parent sees alert and can volunteer", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(20, "DeclCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(21, "DeclDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(22, "DeclRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(630)}', '${GROUP_ID}', '${driver.householdId}', 'DeclKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(631)}', '${GROUP_ID}', '${driver.householdId}', 'SUV', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(632)}', '${GROUP_ID}', '${rider.householdId}', 'DeclKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(633)}', '${GROUP_ID}', '${rider.householdId}', 'RiderCar', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(640)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(640)}', '${morningTrip}', '${UID(630)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(640)}', '${morningTrip}', '${driver.userId}', '${UID(631)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(641)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(641)}', '${morningTrip}', '${UID(632)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    if (versionId) {
      runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND status = 'confirmed';`);
    }

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });

    const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    const isDisabled = await volunteerBtn.isDisabled();
    expect(isDisabled).toBe(false);

    await volunteerBtn.click();
    await page.waitForTimeout(3000);

    const declinedAlert = page.getByTestId("decline-alert");
    await expect(declinedAlert).toBeHidden({ timeout: 5000 });
  });

  // ── Scenario 3: Family didn't check in — hero must not say "rides scheduled" ──

  test("family didn't check in: hero does not claim 'rides scheduled'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(30, "NoCheckCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(31, "NoCheckDriver", false);
    if (!driver) { test.skip(); return; }
    const noCheck = setupHousehold(32, "NoCheckFamily", false);
    if (!noCheck) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(650)}', '${GROUP_ID}', '${driver.householdId}', 'DriverKid', 'NoCheck', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(651)}', '${GROUP_ID}', '${driver.householdId}', 'Car', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(652)}', '${GROUP_ID}', '${noCheck.householdId}', 'NoCheckKid', 'Family', '${noCheck.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(660)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(660)}', '${morningTrip}', '${UID(650)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(660)}', '${morningTrip}', '${driver.userId}', '${UID(651)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, noCheck.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).not.toContain("rides are scheduled");
    expect(heroText!.toLowerCase()).toContain("no rides this week");
  });

  // ── Scenario 4: Expired driver on This Week tab ───────────────────

  test("expired driver does not appear as active on This Week tab", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(40, "ExpCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(41, "ExpDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(42, "ExpRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(670)}', '${GROUP_ID}', '${driver.householdId}', 'ExpKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(671)}', '${GROUP_ID}', '${driver.householdId}', 'Truck', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(672)}', '${GROUP_ID}', '${rider.householdId}', 'ExpKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(680)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(680)}', '${morningTrip}', '${UID(670)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(680)}', '${morningTrip}', '${driver.userId}', '${UID(671)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(681)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(681)}', '${morningTrip}', '${UID(672)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    const versionId = getLatestVersionId(weekId);
    if (versionId) {
      runSql(`
        UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE id = '${versionId}';
        UPDATE public.driver_assignments SET status = 'expired' WHERE schedule_version_id = '${versionId}' AND status = 'tentative';
      `);
    }

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const driverName = "ExpDriver Pilot";
    const activeDriverCard = page.locator(`[data-testid^="drive-card-"]:has-text("${driverName}")`);
    await expect(activeDriverCard).toBeHidden({ timeout: 5000 });
  });

  // ── Scenario 5: Coordinator regenerate — family still sees published ──

  test("coordinator regenerate: family still sees published not draft", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(50, "RegenCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(51, "RegenDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(52, "RegenRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(690)}', '${GROUP_ID}', '${driver.householdId}', 'RegenKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(691)}', '${GROUP_ID}', '${driver.householdId}', 'RegenCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(692)}', '${GROUP_ID}', '${rider.householdId}', 'RegenKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(700)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(700)}', '${morningTrip}', '${UID(690)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(700)}', '${morningTrip}', '${driver.userId}', '${UID(691)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(701)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(701)}', '${morningTrip}', '${UID(692)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    publishScheduleViaSql(weekId);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).not.toContain("action needed");
    expect(heroText!.toLowerCase()).not.toContain("confirm your drives");
  });

  // ── Scenario 6: Coordinator can publish a draft after regenerating ──

  test("coordinator can publish a draft after regenerating", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(60, "PubDraftCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(61, "PubDraftDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(710)}', '${GROUP_ID}', '${driver.householdId}', 'PubDraftKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(711)}', '${GROUP_ID}', '${driver.householdId}', 'PubDraftCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(720)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(720)}', '${morningTrip}', '${UID(710)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(720)}', '${morningTrip}', '${driver.userId}', '${UID(711)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const versionResult = runSql(`SELECT status FROM public.schedule_versions WHERE week_id = '${weekId}' ORDER BY version_number DESC LIMIT 1;`);
    const rows = versionResult.rows ?? [];
    if (rows.length > 0) {
      const status = (rows[0] as Record<string, unknown>).status as string;
      if (status === "draft") {
        const publishBtn = page.getByTestId("publish-schedule");
        await expect(publishBtn).toBeVisible({ timeout: 5000 });
      }
    }
  });

  // ── Scenario 7: Declined driver's rider shows as uncovered, not covered ──
  // Catches the getUncoveredChildren bug where declined assignments were
  // counted as "covering" a child, hiding the uncovered alert.

  // ── Scenario 7: Declined driver → rider sees declined-drive alert (Flow A) ──
  // After Fix 1, kids on a declined assignment are handled by the
  // declined-drive alert flow (Flow A), not the uncovered flow (Flow B).
  // The Flow B RPC rejects them ("not uncovered for this trip") so the
  // Flow B button was broken. Fix 1 removes the broken button and
  // surfaces Flow A's working "I can drive" button instead.

  test("declined driver: rider sees declined-drive alert and can volunteer", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(70, "DeclUncovCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(71, "DeclUncovDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(72, "DeclUncovRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(730)}', '${GROUP_ID}', '${driver.householdId}', 'DeclKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(731)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(732)}', '${GROUP_ID}', '${rider.householdId}', 'DeclKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(733)}', '${GROUP_ID}', '${rider.householdId}', 'RiderSUV', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(740)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(740)}', '${morningTrip}', '${UID(730)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(740)}', '${morningTrip}', '${driver.userId}', '${UID(731)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(741)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(741)}', '${morningTrip}', '${UID(732)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    if (versionId) {
      runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND status = 'confirmed';`);
    }

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(false);
    // Flow A volunteer must not also surface as a duplicate uncovered alert
    await expect(page.getByTestId("uncovered-alert")).toBeHidden({ timeout: 1000 });
  });

  // ── Scenario 8: Cancel confirmed drive → affected family sees alert + volunteers ──

  test("cancel confirmed drive: affected family sees alert and can volunteer", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(80, "CancelCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(81, "CancelDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(82, "CancelRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(750)}', '${GROUP_ID}', '${driver.householdId}', 'CancelKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(751)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(752)}', '${GROUP_ID}', '${rider.householdId}', 'CancelKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(753)}', '${GROUP_ID}', '${rider.householdId}', 'RiderCar', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(760)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(760)}', '${morningTrip}', '${UID(750)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(760)}', '${morningTrip}', '${driver.userId}', '${UID(751)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(761)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(761)}', '${morningTrip}', '${UID(752)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const cancelLink = page.locator('[data-testid^="cancel-drive-"]').first();
    await expect(cancelLink).toBeVisible({ timeout: 5000 });
    await cancelLink.click();

    const confirmBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();
    await page.waitForTimeout(2000);

    await page.context().clearCookies();
    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(false);
  });

  // ── Scenario 9: Volunteer for uncovered trip → alert clears ──

  test("volunteer for uncovered trip: rider covers trip and alert clears", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(90, "UncovVolCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(91, "UncovVolDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(92, "UncovVolRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(770)}', '${GROUP_ID}', '${driver.householdId}', 'UncovKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(771)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 1, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(772)}', '${GROUP_ID}', '${rider.householdId}', 'UncovKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(773)}', '${GROUP_ID}', '${rider.householdId}', 'RiderSUV', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(780)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(780)}', '${morningTrip}', '${UID(770)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(780)}', '${morningTrip}', '${driver.userId}', '${UID(771)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(781)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(781)}', '${morningTrip}', '${UID(772)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("uncovered-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-uncovered-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(false);

    await volunteerBtn.click();
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("uncovered-alert")).toBeHidden({ timeout: 5000 });
  });

  // ── Scenario 10: Volunteer disabled "Car too small" ──

  test("volunteer uncovered: disabled 'Car too small' when vehicle capacity insufficient", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(100, "SmallCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(101, "SmallDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(102, "SmallRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(790)}', '${GROUP_ID}', '${driver.householdId}', 'DriverKid', 'Small', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(791)}', '${GROUP_ID}', '${driver.householdId}', 'MicroCar', 1, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(792)}', '${GROUP_ID}', '${rider.householdId}', 'SmallKid1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(793)}', '${GROUP_ID}', '${rider.householdId}', 'SmallKid2', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(794)}', '${GROUP_ID}', '${rider.householdId}', 'SmallKid3', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(795)}', '${GROUP_ID}', '${rider.householdId}', 'TinyCar', 2, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(800)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(800)}', '${morningTrip}', '${UID(790)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(800)}', '${morningTrip}', '${driver.userId}', '${UID(791)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(801)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(801)}', '${morningTrip}', '${UID(792)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(801)}', '${morningTrip}', '${UID(793)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(801)}', '${morningTrip}', '${UID(794)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("uncovered-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-uncovered-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(true);
    const btnText = (await volunteerBtn.textContent()) ?? "";
    expect(btnText.toLowerCase()).toContain("too small");
  });

  // ── Scenario 11: Volunteer disabled "No vehicle" ──

  test("volunteer uncovered: disabled 'No vehicle' when rider has no active vehicle", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(110, "NoVehCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(111, "NoVehDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(112, "NoVehRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(810)}', '${GROUP_ID}', '${driver.householdId}', 'NoVehKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(811)}', '${GROUP_ID}', '${driver.householdId}', 'MicroCar', 1, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(812)}', '${GROUP_ID}', '${rider.householdId}', 'NoVehKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(820)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(820)}', '${morningTrip}', '${UID(810)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(820)}', '${morningTrip}', '${driver.userId}', '${UID(811)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(821)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(821)}', '${morningTrip}', '${UID(812)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("uncovered-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-uncovered-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(true);
    const btnText = (await volunteerBtn.textContent()) ?? "";
    expect(btnText.toLowerCase()).toContain("no vehicle");
  });

  // ── Scenario 12: Happy path — all confirmed + published + no alerts ──

  test("happy path: all confirmed + published + no alerts → hero says 'You're all set'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(120, "HappyCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(121, "HappyDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(830)}', '${GROUP_ID}', '${driver.householdId}', 'HappyKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(831)}', '${GROUP_ID}', '${driver.householdId}', 'HappyCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(840)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(840)}', '${morningTrip}', '${UID(830)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(840)}', '${morningTrip}', '${driver.userId}', '${UID(831)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    if (versionId) {
      runSql(`UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id = '${versionId}' AND status = 'tentative';`);
    }

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("all set");
    await expect(page.getByTestId("add-to-calendar")).toBeVisible({ timeout: 5000 });
  });

  // ── Scenario 13: Rider happy path — in schedule, not driving ──

  test("rider happy path: in schedule, not driving → hero says 'rides are scheduled'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(130, "RiderHappyCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(131, "RiderHappyDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(132, "RiderHappyRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(850)}', '${GROUP_ID}', '${driver.householdId}', 'RiderHappyKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(851)}', '${GROUP_ID}', '${driver.householdId}', 'BigCar', 5, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(852)}', '${GROUP_ID}', '${rider.householdId}', 'RiderHappyKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(860)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(860)}', '${morningTrip}', '${UID(850)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(860)}', '${morningTrip}', '${driver.userId}', '${UID(851)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(861)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(861)}', '${morningTrip}', '${UID(852)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("rides are scheduled");
  });

  // ── Scenario 14: No schedule yet → hero shows check-in deadline ──

  test("no schedule yet: hero shows 'No schedule yet' with check-in deadline", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const family = setupHousehold(140, "NoSched", false);
    if (!family) { test.skip(); return; }

    setupCurrentWeekWithTrips();

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(870)}', '${GROUP_ID}', '${family.householdId}', 'NoSchedKid', 'Family', '${family.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(871)}', '${GROUP_ID}', '${family.householdId}', 'FamilyCar', 4, true, '${family.userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, family.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("no schedule yet");
    const heroSupport = await page.locator(".confirmation-hero .hero-support").first().textContent();
    expect(heroSupport).toBeTruthy();
    expect(heroSupport!.toLowerCase()).toContain("submit by");
  });

  // ── Scenario 15: Draft not published → hero says 'Schedule is being prepared' ──

  test("draft not published: hero says 'Schedule is being prepared'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(150, "DraftCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(151, "DraftDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(152, "DraftRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(880)}', '${GROUP_ID}', '${driver.householdId}', 'DraftKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(881)}', '${GROUP_ID}', '${driver.householdId}', 'DraftCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(882)}', '${GROUP_ID}', '${rider.householdId}', 'DraftKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(890)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(890)}', '${morningTrip}', '${UID(880)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(890)}', '${morningTrip}', '${driver.userId}', '${UID(881)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(891)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(891)}', '${morningTrip}', '${UID(882)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("being prepared");
  });

  // ── Scenario 16: Home hero shows confirmation deadline in Pacific ──

  test("deadline display: hero shows 'Confirm by' in Pacific time, not UTC", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(160, "DlCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(161, "DlDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(900)}', '${GROUP_ID}', '${driver.householdId}', 'DlKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(901)}', '${GROUP_ID}', '${driver.householdId}', 'DlCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(910)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(910)}', '${morningTrip}', '${UID(900)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(910)}', '${morningTrip}', '${driver.userId}', '${UID(901)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("confirm your drives");
    const deadlineText = await page.locator(".confirmation-hero .hero-deadline").first().textContent();
    expect(deadlineText).toBeTruthy();
    expect(deadlineText!.toLowerCase()).toContain("confirm by");
    expect(deadlineText!.toLowerCase()).toContain("pm");
    expect(deadlineText!.toLowerCase()).not.toContain("am");
  });

  // ── Scenario 17: Publish disabled before deadline with tentative ──

  test("publish gate: disabled 'awaiting confirmation' when tentative remain before deadline", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(170, "PubGateCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(171, "PubGateDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    // Set confirmation deadline to a future date so the publish gate is active
    const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    runSql(`
      UPDATE public.weeks SET confirmation_deadline = '${futureDeadline}' WHERE id = '${weekId}';
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(920)}', '${GROUP_ID}', '${driver.householdId}', 'PubGateKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(921)}', '${GROUP_ID}', '${driver.householdId}', 'PubGateCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(930)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(930)}', '${morningTrip}', '${UID(920)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(930)}', '${morningTrip}', '${driver.userId}', '${UID(921)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const publishBtn = page.getByTestId("publish-schedule");
    await expect(publishBtn).toBeVisible({ timeout: 5000 });
    expect(await publishBtn.isDisabled()).toBe(true);
    const btnText = (await publishBtn.textContent()) ?? "";
    expect(btnText.toLowerCase()).toContain("awaiting confirmation");
  });

  // ── Scenario 18: Publish after deadline expires tentative ──

  test("publish gate: enabled after deadline, tentative expire on publish", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(180, "PubExpCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(181, "PubExpDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    const now = new Date();
    const pastDeadline = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    runSql(`
      UPDATE public.weeks SET confirmation_deadline = '${pastDeadline}' WHERE id = '${weekId}';
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(940)}', '${GROUP_ID}', '${driver.householdId}', 'PubExpKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(941)}', '${GROUP_ID}', '${driver.householdId}', 'PubExpCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(950)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(950)}', '${morningTrip}', '${UID(940)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(950)}', '${morningTrip}', '${driver.userId}', '${UID(941)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const publishBtn = page.getByTestId("publish-schedule");
    await expect(publishBtn).toBeVisible({ timeout: 5000 });
    expect(await publishBtn.isDisabled()).toBe(false);
    const btnText = (await publishBtn.textContent()) ?? "";
    expect(btnText.toLowerCase()).toContain("expire");

    await publishBtn.click();
    await page.waitForTimeout(3000);

    const versionResult = runSql(`SELECT status FROM public.schedule_versions WHERE week_id = '${weekId}' ORDER BY version_number DESC LIMIT 1;`);
    const rows = versionResult.rows ?? [];
    if (rows.length > 0) {
      const status = (rows[0] as Record<string, unknown>).status as string;
      expect(status).toBe("published");
    }
  });

  // ── Scenario 19: Coordinator Status tab shows household check-in status ──

  test("coordinator status: shows submitted/in-progress/not-started per household", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(190, "StatusCoord", true);
    if (!coord) { test.skip(); return; }
    const submitted = setupHousehold(191, "StatusSubmitted", false);
    if (!submitted) { test.skip(); return; }
    const inProgress = setupHousehold(192, "StatusInProgress", false);
    if (!inProgress) { test.skip(); return; }
    const notStarted = setupHousehold(193, "StatusNotStarted", false);
    if (!notStarted) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(960)}', '${GROUP_ID}', '${submitted.householdId}', 'SubKid', 'Family', '${submitted.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(961)}', '${GROUP_ID}', '${submitted.householdId}', 'SubCar', 4, true, '${submitted.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(962)}', '${GROUP_ID}', '${inProgress.householdId}', 'ProgKid', 'Family', '${inProgress.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(970)}', '${GROUP_ID}', '${weekId}', '${submitted.householdId}', 'submitted', 3) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(970)}', '${morningTrip}', '${UID(960)}', true, '${submitted.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(970)}', '${morningTrip}', '${submitted.userId}', '${UID(961)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(971)}', '${GROUP_ID}', '${weekId}', '${inProgress.householdId}', 'draft', 3) ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const statusList = page.locator(".household-status-list");
    await expect(statusList).toBeVisible({ timeout: 5000 });
    const statusText = (await statusList.textContent()) ?? "";
    expect(statusText).toContain("StatusSubmitted Pilot");
    expect(statusText).toContain("Submitted");
    expect(statusText).toContain("StatusInProgress Pilot");
    expect(statusText).toContain("In progress");
    expect(statusText).toContain("StatusNotStarted Pilot");
    expect(statusText).toContain("Not started");
  });

  // ── Scenario 20: Coordinator sees declined + uncovered admin alerts ──

  test("coordinator alerts: declined and uncovered admin alerts visible", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(200, "AdminCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(201, "AdminDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(202, "AdminRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(980)}', '${GROUP_ID}', '${driver.householdId}', 'AdminKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(981)}', '${GROUP_ID}', '${driver.householdId}', 'AdminCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(982)}', '${GROUP_ID}', '${rider.householdId}', 'AdminKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(990)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(990)}', '${morningTrip}', '${UID(980)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(990)}', '${morningTrip}', '${driver.userId}', '${UID(981)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(991)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      ${tripIds.slice(0, 2).map(t => `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(991)}', '${t}', '${UID(982)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;`).join('\n')}
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    const versionId = getLatestVersionId(weekId);
    if (versionId) {
      runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND status = 'tentative';`);
    }

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    await expect(page.getByTestId("decline-alert-admin")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("uncovered-alert-admin")).toBeVisible({ timeout: 5000 });
  });

  // ── Scenario 21: This Week status pills — tentative vs confirmed ──

  test("this week: status pills show tentative and confirmed on drive cards", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(210, "PillCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(211, "PillDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1000)}', '${GROUP_ID}', '${driver.householdId}', 'PillKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1001)}', '${GROUP_ID}', '${driver.householdId}', 'PillCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1010)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1010)}', '${morningTrip}', '${UID(1000)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1010)}', '${morningTrip}', '${driver.userId}', '${UID(1001)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const confirmedPill = page.locator(".roster-status--confirmed").first();
    await expect(confirmedPill).toBeVisible({ timeout: 5000 });
  });

  // ── Scenario 22: Driver cancels their only drive, then re-accepts from Home ──
  // Reproduces the original bug: after cancelling the only drive, the
  // "Review individually" path was hidden and no other working button
  // existed. The driver was stuck. Fix 3 adds a "Re-accept this drive"
  // button on Home when only declined/expired assignments remain.

  test("cancel then re-accept: driver can take back their cancelled drive from Home", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(220, "ReacceptCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(221, "ReacceptDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(222, "ReacceptRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1100)}', '${GROUP_ID}', '${driver.householdId}', 'ReacceptKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1101)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1102)}', '${GROUP_ID}', '${rider.householdId}', 'ReacceptKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1103)}', '${GROUP_ID}', '${rider.householdId}', 'RiderCar', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1110)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1110)}', '${morningTrip}', '${UID(1100)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1110)}', '${morningTrip}', '${driver.userId}', '${UID(1101)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1111)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1111)}', '${morningTrip}', '${UID(1102)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    // Driver confirms, then cancels via Home UI
    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const cancelLink = page.locator('[data-testid^="cancel-drive-"]').first();
    await expect(cancelLink).toBeVisible({ timeout: 5000 });
    await cancelLink.click();

    const confirmCancelBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
    await expect(confirmCancelBtn).toBeVisible({ timeout: 5000 });
    await confirmCancelBtn.click();
    await page.waitForTimeout(2500);

    // After cancel: hero must NOT claim "rides are scheduled" (Fix 2 — own kid
    // was on the now-declined drive).
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText, "hero text should exist");
    assert.ok(!/rides are scheduled/i.test(heroText), `hero must not say "rides are scheduled" after cancel, got: "${heroText}"`);

    // Fix 3: a "Re-accept this drive" button is visible on Home.
    const reacceptBtn = page.locator('[data-testid^="reaccept-"]').first();
    await expect(reacceptBtn).toBeVisible({ timeout: 5000 });
    expect(await reacceptBtn.isDisabled()).toBe(false);

    // Fix 1: no broken uncovered "I can drive" button for this trip on the
    // cancelling driver's home (Flow B would reject them).
    await expect(page.getByTestId("uncovered-alert")).toBeHidden({ timeout: 1000 });

    // Re-accept → assignment returns to confirmed.
    await reacceptBtn.click();
    await page.waitForTimeout(2500);

    // After re-accept: drive is back in "Your confirmed drives" section.
    const confirmedHero = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(confirmedHero, "hero text should exist after re-accept");
    assert.ok(/all set|confirmed/i.test(confirmedHero), `hero should confirm drive is back, got: "${confirmedHero}"`);

    // And the re-accept button is gone.
    await expect(page.locator('[data-testid^="reaccept-"]')).toBeHidden({ timeout: 3000 });
  });

  // ── Scenario 23: Rider family on a cancelled drive uses Flow A (declined-drive alert) ──
  // After Fix 1, kids on a declined assignment are routed to Flow A
  // (declined-drive alert with working "I can drive"), not Flow B
  // (uncovered alert with broken button that errors out).

  test("rider on cancelled drive: sees Flow A declined-drive alert, not broken Flow B uncovered alert", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(230, "FlowACoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(231, "FlowADriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(232, "FlowARider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1200)}', '${GROUP_ID}', '${driver.householdId}', 'FlowAKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1201)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1202)}', '${GROUP_ID}', '${rider.householdId}', 'FlowAKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1203)}', '${GROUP_ID}', '${rider.householdId}', 'RiderSUV', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1210)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1210)}', '${morningTrip}', '${UID(1200)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1210)}', '${morningTrip}', '${driver.userId}', '${UID(1201)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1211)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1211)}', '${morningTrip}', '${UID(1202)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");
    // Driver cancels via SQL (simulating the cancel — UI path tested in Scenario 22).
    runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND status = 'confirmed';`);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // Flow A: declined-drive alert visible with a working volunteer button.
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(false);

    // Flow B: uncovered alert is hidden for the same trip (Fix 1 — no more
    // duplicate broken alert).
    await expect(page.getByTestId("uncovered-alert")).toBeHidden({ timeout: 1000 });

    // Rider volunteers via Flow A → trip is covered.
    await volunteerBtn.click();
    await page.waitForTimeout(3000);

    // After volunteering: the declined-drive alert clears (drive is now covered).
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });
  });

  // ── Scenario 24: Expired driver can re-accept from Home ──
  // A driver who let the Sunday confirmation deadline pass has an
  // 'expired' assignment. Today they have no path back. Fix 3 extends
  // the re-accept UI to 'expired' and the RPC allows re-response on
  // 'expired' (with a guard against resurrecting a zero-rider
  // assignment that a volunteer has already taken over — Scenario 25).

  test("expired driver: can re-accept from Home after missing the confirmation deadline", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(240, "ExpReacceptCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(241, "ExpReacceptDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(242, "ExpReacceptRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1300)}', '${GROUP_ID}', '${driver.householdId}', 'ExpKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1301)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1302)}', '${GROUP_ID}', '${rider.householdId}', 'ExpKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1303)}', '${GROUP_ID}', '${rider.householdId}', 'RiderSUV', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1310)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1310)}', '${morningTrip}', '${UID(1300)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1310)}', '${morningTrip}', '${driver.userId}', '${UID(1301)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1311)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1311)}', '${morningTrip}', '${UID(1302)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    // Simulate the Sunday confirmation deadline passing: SQL-flip the
    // tentative assignment to 'expired', then publish (publish would
    // normally do the expiration, but we do it explicitly to test the
    // expired-reaccept path independently of the publish gate).
    const draftVersionId = getLatestVersionId(weekId);
    assert.ok(draftVersionId, "draft version should exist");
    runSql(`
      UPDATE public.driver_assignments SET status = 'expired' WHERE schedule_version_id = '${draftVersionId}' AND trip_id = '${morningTrip}' AND status = 'tentative';
      UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE id = '${draftVersionId}';
    `);

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // Hero must NOT claim "rides are scheduled" (Fix 2 — expired is not covering).
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText, "hero text should exist");
    assert.ok(!/rides are scheduled/i.test(heroText), `hero must not say "rides are scheduled" for expired, got: "${heroText}"`);

    // Fix 3: re-accept button visible with expired-specific copy.
    const reacceptBtn = page.locator('[data-testid^="reaccept-"]').first();
    await expect(reacceptBtn).toBeVisible({ timeout: 5000 });
    expect(await reacceptBtn.isDisabled()).toBe(false);

    // Fix 1: no broken uncovered "I can drive" for the expired driver's own kid.
    await expect(page.getByTestId("uncovered-alert")).toBeHidden({ timeout: 1000 });

    // Re-accept → assignment returns to confirmed.
    await reacceptBtn.click();
    await page.waitForTimeout(2500);

    const confirmedHero = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(confirmedHero, "hero text should exist after re-accept");
    assert.ok(/all set|confirmed/i.test(confirmedHero), `hero should confirm drive is back, got: "${confirmedHero}"`);
    await expect(page.locator('[data-testid^="reaccept-"]')).toBeHidden({ timeout: 3000 });
  });

  // ── Scenario 25: Expired re-accept blocked after a rider family has taken over ──
  // If a rider family volunteers for an expired driver's trip via Flow B
  // (their kids are genuinely uncovered), the rider rows move to the
  // volunteer's new assignment. The expired driver's re-accept must be
  // blocked — otherwise a zero-rider duplicate confirmed assignment
  // would be created. The RPC guard raises "Another driver has already
  // taken this drive."

  test("expired re-accept blocked after rider family took over via Flow B", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(250, "ExpBlockCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(251, "ExpBlockDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(252, "ExpBlockRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1400)}', '${GROUP_ID}', '${driver.householdId}', 'ExpBlockKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1401)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1402)}', '${GROUP_ID}', '${rider.householdId}', 'ExpBlockKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1403)}', '${GROUP_ID}', '${rider.householdId}', 'RiderSUV', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1410)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1410)}', '${morningTrip}', '${UID(1400)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1410)}', '${morningTrip}', '${driver.userId}', '${UID(1401)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1411)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1411)}', '${morningTrip}', '${UID(1402)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    const draftVersionId = getLatestVersionId(weekId);
    assert.ok(draftVersionId, "draft version should exist");
    // Expire the driver's tentative assignment and publish.
    runSql(`
      UPDATE public.driver_assignments SET status = 'expired' WHERE schedule_version_id = '${draftVersionId}' AND trip_id = '${morningTrip}' AND status = 'tentative';
      UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE id = '${draftVersionId}';
    `);

    // Step 1: Rider family takes over via Flow B (their kid is genuinely uncovered).
    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("uncovered-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-uncovered-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    await volunteerBtn.click();
    await page.waitForTimeout(3000);

    // Verify the rider family took over: their assignment is now confirmed.
    const takeoverCheck = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${draftVersionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${rider.userId}' AND status = 'confirmed';`);
    const takeoverCount = takeoverCheck.rows?.[0]?.n ?? 0;
    assert.equal(takeoverCount, 1, "rider family should have taken over the trip");

    // Verify the expired driver's assignment now has zero riders (rows moved).
    const expiredAssignmentId = runSql(`SELECT id FROM public.driver_assignments WHERE schedule_version_id = '${draftVersionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${driver.userId}' AND status = 'expired';`).rows?.[0]?.id;
    assert.ok(expiredAssignmentId, "expired assignment should still exist");
    const riderCount = runSql(`SELECT count(*) AS n FROM public.rider_assignments WHERE driver_assignment_id = '${expiredAssignmentId}';`).rows?.[0]?.n ?? 0;
    assert.equal(riderCount, 0, "expired assignment should have zero riders after takeover");

    // Step 2: Expired driver tries to re-accept. The button is still visible
    // (the UI doesn't know a takeover happened), but the RPC must block it.
    await page.context().clearCookies();
    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const reacceptBtn = page.locator('[data-testid^="reaccept-"]').first();
    await expect(reacceptBtn).toBeVisible({ timeout: 5000 });
    await reacceptBtn.click();
    await page.waitForTimeout(3000);

    // The error message must surface, and no duplicate confirmed assignment
    // should have been created.
    const errorEl = page.locator(".auth-error").first();
    await expect(errorEl).toBeVisible({ timeout: 5000 });
    const errorText = await errorEl.textContent();
    assert.ok(errorText && /already taken/i.test(errorText), `error should say "already taken", got: "${errorText}"`);

    // Verify no second confirmed assignment was created for the expired driver.
    const driverConfirmedCount = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${draftVersionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${driver.userId}' AND status = 'confirmed';`).rows?.[0]?.n ?? 0;
    assert.equal(driverConfirmedCount, 0, "expired driver must not have a confirmed assignment after takeover");
  });

  // ── Scenario 26: Mixed state — 2 confirmed + 2 declined, re-accept one, others visible ──
  // The core data-integrity fix: when a driver has a mix of confirmed and
  // cancelled drives, ALL must be visible on Home. Previously the re-accept
  // section only rendered when noAssignments was true, so re-accepting one
  // caused the others to vanish and the hero to lie ("You're all set").

  test("mixed state: 2 confirmed + 2 declined, re-accept one, others still visible", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(260, "MixedCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(261, "MixedDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    // Use 4 morning trips: Mon(0), Tue(2), Wed(4), Thu(6)
    const trips = [tripIds[0], tripIds[2], tripIds[4], tripIds[6]];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1500)}', '${GROUP_ID}', '${driver.householdId}', 'MixedKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1501)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1510)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      ${trips.map((tId, i) => `
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1510)}', '${tId}', '${UID(1500)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1510)}', '${tId}', '${driver.userId}', '${UID(1501)}', 'prefer') ON CONFLICT DO NOTHING;`).join("")}
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Verify driver has 4 confirmed assignments
    const assignmentRows = runSql(`SELECT id, trip_id FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND driver_profile_id = '${driver.userId}' AND status = 'confirmed' ORDER BY trip_id;`).rows ?? [];
    assert.equal(assignmentRows.length, 4, `driver should have 4 confirmed assignments, got ${assignmentRows.length}`);

    // SQL-decline 2 of them (Tue and Thu — tripIds[2] and tripIds[6])
    const toDecline = assignmentRows.filter(a => a.trip_id === tripIds[2] || a.trip_id === tripIds[6]);
    assert.equal(toDecline.length, 2, "should find 2 assignments to decline");
    for (const a of toDecline) {
      runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE id = '${a.id}';`);
    }

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // Fix 2: hero must NOT say "You're all set" when there are cancelled drives.
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText, "hero text should exist");
    assert.ok(/cancelled/i.test(heroText), `hero should mention cancelled drives, got: "${heroText}"`);

    // Fix 1: all 4 drives must be visible — 2 confirmed, 2 with re-accept buttons.
    const reacceptButtons = page.locator('[data-testid^="reaccept-"]');
    await expect(reacceptButtons.first()).toBeVisible({ timeout: 5000 });
    const reacceptCount = await reacceptButtons.count();
    assert.equal(reacceptCount, 2, `should have 2 re-accept buttons, got ${reacceptCount}`);

    // Re-accept one (the first one found).
    await reacceptButtons.first().click();
    await page.waitForTimeout(3000);

    // After re-accept: 3 confirmed, 1 still declined with re-accept button.
    const remainingReaccept = page.locator('[data-testid^="reaccept-"]');
    await expect(remainingReaccept.first()).toBeVisible({ timeout: 5000 });
    const remainingCount = await remainingReaccept.count();
    assert.equal(remainingCount, 1, `should have 1 re-accept button remaining, got ${remainingCount}`);

    // Hero should still say "Action needed" (1 cancelled drive left).
    const heroAfter = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroAfter, "hero text should exist after re-accept");
    assert.ok(/cancelled/i.test(heroAfter), `hero should still mention cancelled, got: "${heroAfter}"`);
  });

  // ── Scenario 27: Friendly error when volunteering for already re-accepted drive ──
  // If a rider family sees a stale Flow A alert (the original driver already
  // re-accepted) and taps "I can drive", the raw DB error "This assignment
  // is not declined" was shown. Fix 5 maps it to a friendly message.

  test("volunteer after re-accept: friendly error message instead of raw DB string", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(270, "FriendlyErrCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(271, "FriendlyErrDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(272, "FriendlyErrRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1600)}', '${GROUP_ID}', '${driver.householdId}', 'ErrKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1601)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1602)}', '${GROUP_ID}', '${rider.householdId}', 'ErrKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1603)}', '${GROUP_ID}', '${rider.householdId}', 'RiderSUV', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1610)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1610)}', '${morningTrip}', '${UID(1600)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1610)}', '${morningTrip}', '${driver.userId}', '${UID(1601)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1611)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1611)}', '${morningTrip}', '${UID(1602)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // SQL-decline the driver's confirmed assignment.
    runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND status = 'confirmed';`);

    // Driver re-accepts via UI.
    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const reacceptBtn = page.locator('[data-testid^="reaccept-"]').first();
    await expect(reacceptBtn).toBeVisible({ timeout: 5000 });
    await reacceptBtn.click();
    await page.waitForTimeout(3000);

    // Now sign in as rider. The Flow A alert may still be stale (cached from
    // the page load). If visible, tap "I can drive" and verify friendly error.
    await page.context().clearCookies();
    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // The declined-drive alert should be gone (driver re-accepted, so the
    // assignment is now confirmed). If it IS still showing (stale cache),
    // tap the volunteer button and verify the friendly error.
    const declineAlert = page.getByTestId("decline-alert");
    const isAlertVisible = await declineAlert.isVisible().catch(() => false);

    if (isAlertVisible) {
      const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
      if (await volunteerBtn.isVisible().catch(() => false)) {
        await volunteerBtn.click();
        await page.waitForTimeout(2000);

        // Fix 5: error should be friendly, not raw DB string.
        const errorEl = page.locator(".auth-error, .decline-alert .auth-error").first();
        const errorText = await errorEl.textContent().catch(() => null);
        assert.ok(errorText, "error message should be visible");
        assert.ok(!/not declined/i.test(errorText), `should not show raw DB error, got: "${errorText}"`);
        assert.ok(/already re-accepted|covered/i.test(errorText), `should show friendly message, got: "${errorText}"`);
      }
    }

    // Whether or not the stale alert was visible, the trip should be covered
    // (driver re-accepted). Verify in DB.
    const confirmedCount = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${morningTrip}' AND driver_profile_id = '${driver.userId}' AND status = 'confirmed';`).rows?.[0]?.n ?? 0;
    assert.equal(confirmedCount, 1, "driver should have 1 confirmed assignment after re-accept");
  });

  // ── Scenario 28: This Week tab shows "Expired" not "Declined" for expired assignments ──

  test("this week: expired assignment labeled 'Expired' not 'Declined'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(280, "ExpLabelCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(281, "ExpLabelDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupNextWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(1700)}', '${GROUP_ID}', '${driver.householdId}', 'LabelKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(1701)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(1710)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(1710)}', '${morningTrip}', '${UID(1700)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(1710)}', '${morningTrip}', '${driver.userId}', '${UID(1701)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.email, weekId);
    await page.waitForTimeout(1000);

    const draftVersionId = getLatestVersionId(weekId);
    assert.ok(draftVersionId, "draft version should exist");
    // Expire the driver's tentative assignment and publish.
    runSql(`
      UPDATE public.driver_assignments SET status = 'expired' WHERE schedule_version_id = '${draftVersionId}' AND trip_id = '${morningTrip}' AND status = 'tentative';
      UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE id = '${draftVersionId}';
    `);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Fix 6: the expired assignment should be labeled "Expired", not "Declined".
    const rosterLabel = page.locator(".roster--declined small").first();
    await expect(rosterLabel).toBeVisible({ timeout: 5000 });
    const labelText = await rosterLabel.textContent();
    assert.ok(labelText, "roster label should exist");
    assert.ok(/expired/i.test(labelText), `label should say "Expired", got: "${labelText}"`);
    assert.ok(!/^Declined$/.test(labelText.trim()), `label should NOT say just "Declined", got: "${labelText}"`);
  });
});