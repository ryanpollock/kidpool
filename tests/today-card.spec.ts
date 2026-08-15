// E2E tests for the Today card + cancel/add-ride-back feature.
// Creates test data with trips for the current week (today's date),
// generates + publishes a schedule, then verifies the Today card
// renders correctly and cancel/add-back works end-to-end.

import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { getSpecEnv, makeRunSql, makeAuth, UID, PILOT_GROUP_ID, TEST_PASSWORD, signInWithTestAuth } from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteAllTestUsers } = makeAuth(env);
const skip = !env.serviceKey;

const SUPABASE_URL = env.supabaseUrl;
const ANON_KEY = env.anonKey;
const GROUP_ID = PILOT_GROUP_ID;

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

function todayStrSF(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@today.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(700 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Today') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Today', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function setupCurrentWeekWithTrips() {
  const weekStart = currentMondayStrSF();
  const weekId = UID(970);
  const tripIds: string[] = [];
  const dates: string[] = [];
  const [my, mm, md] = weekStart.split("-").map(Number);
  const mondayDate = new Date(Date.UTC(my, mm - 1, md));
  let sql = `INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${weekId}', '${GROUP_ID}', '${weekStart}', 'open') ON CONFLICT DO NOTHING;\n`;
  for (let d = 0; d < 5; d++) {
    const tripDate = new Date(Date.UTC(my, mm - 1, md + d));
    const dateStr = tripDate.toISOString().slice(0, 10);
    dates.push(dateStr);
    for (const dir of ["morning", "afternoon"]) {
      const tId = UID(800 + d * 2 + (dir === "morning" ? 0 : 1));
      tripIds.push(tId);
      sql += `INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${tId}', '${GROUP_ID}', '${weekId}', '${dateStr}', '${dir}', '08:40', '08:45', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;\n`;
    }
  }
  runSql(sql);
  return { weekId, tripIds, dates };
}

function generateSchedule(coordEmail: string, weekId: string) {
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

function getRiderCount(driverAssignmentId: string): number {
  const result = runSql(`SELECT count(*)::int AS n FROM public.rider_assignments WHERE driver_assignment_id = '${driverAssignmentId}';`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).n as number : 0;
}

function getDriverAssignmentId(weekId: string, tripId: string): string | null {
  const result = runSql(`SELECT id FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'published') AND trip_id = '${tripId}' LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).id as string : null;
}

function cleanupTodayData() {
  runSql(`
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id::text LIKE 'deadbeef-%';
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (entity_id::text LIKE 'deadbeef-%' OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@today.kidpool'));
    DELETE FROM public.profiles WHERE email LIKE '%@today.kidpool';
  `);
  deleteAllTestUsers();
}

test.describe.serial("Today Card", () => {
  test.beforeAll(() => { cleanupTodayData(); });
  test.afterAll(() => { cleanupTodayData(); });
  test.afterEach(() => { cleanupTodayData(); });
  test.setTimeout(90000);

  test("Today card shows child's ride info when child is assigned to today's trip", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const today = todayStrSF();
    const dow = new Date(today + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) { test.skip(); return; }

    const coord = setupHousehold(10, "TodayCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(11, "TodayDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(12, "TodayRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds, dates } = setupCurrentWeekWithTrips();
    const todayIdx = dates.indexOf(today);
    if (todayIdx < 0) { test.skip(); return; }
    const morningTrip = tripIds[todayIdx * 2];

    runSql(`
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(711)}', '${GROUP_ID}', '${driver.householdId}', 'TodayCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(712)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(713)}', '${GROUP_ID}', '${rider.householdId}', 'R1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(714)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(715)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(714)}', '${morningTrip}', '${UID(712)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(715)}', '${morningTrip}', '${UID(713)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(714)}', '${morningTrip}', '${driver.userId}', '${UID(711)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    const genResult = generateSchedule(coord.email, weekId);
    expect(genResult.success).toBe(true);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const todayCard = page.getByTestId("today-card");
    await expect(todayCard).toBeVisible({ timeout: 5000 });
    await expect(todayCard).toContainText("R1");
  });

  test("Today card shows 'no ride' when child has no assignment for today", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const today = todayStrSF();
    const dow = new Date(today + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) { test.skip(); return; }

    const coord = setupHousehold(20, "NoRideCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(21, "NoRideDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(22, "NoRideParent", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds, dates } = setupCurrentWeekWithTrips();
    const todayIdx = dates.indexOf(today);
    if (todayIdx < 0) { test.skip(); return; }
    const morningTrip = tripIds[todayIdx * 2];

    runSql(`
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(721)}', '${GROUP_ID}', '${driver.householdId}', 'NoRideCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(722)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(723)}', '${GROUP_ID}', '${rider.householdId}', 'NoRide', 'Child', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(724)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(725)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(724)}', '${morningTrip}', '${UID(722)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(724)}', '${morningTrip}', '${driver.userId}', '${UID(721)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    const genResult = generateSchedule(coord.email, weekId);
    expect(genResult.success).toBe(true);
    publishScheduleViaSql(weekId);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const todayCard = page.getByTestId("today-card");
    await expect(todayCard).toBeVisible({ timeout: 5000 });
    await expect(todayCard).toContainText("No ride");
  });

  test("Cancel ride from Today card updates card and deletes DB row", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const today = todayStrSF();
    const dow = new Date(today + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) { test.skip(); return; }

    const coord = setupHousehold(30, "CancelCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(31, "CancelDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(32, "CancelParent", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds, dates } = setupCurrentWeekWithTrips();
    const todayIdx = dates.indexOf(today);
    if (todayIdx < 0) { test.skip(); return; }
    const morningTrip = tripIds[todayIdx * 2];

    runSql(`
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(731)}', '${GROUP_ID}', '${driver.householdId}', 'CancelCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(732)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(733)}', '${GROUP_ID}', '${rider.householdId}', 'Cancel', 'Child', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(734)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(735)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(734)}', '${morningTrip}', '${UID(732)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(735)}', '${morningTrip}', '${UID(733)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(734)}', '${morningTrip}', '${driver.userId}', '${UID(731)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    const genResult = generateSchedule(coord.email, weekId);
    expect(genResult.success).toBe(true);
    publishScheduleViaSql(weekId);

    const driverAssignmentId = getDriverAssignmentId(weekId, morningTrip);
    expect(driverAssignmentId).not.toBeNull();
    const initialRiderCount = getRiderCount(driverAssignmentId!);
    expect(initialRiderCount).toBeGreaterThanOrEqual(2);

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("today-card")).toBeVisible({ timeout: 5000 });

    const cancelBtn = page.getByTestId("cancel-ride-733");
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });
    await cancelBtn.click();

    const confirmBtn = page.getByTestId("confirm-cancel-ride-733");
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    await page.waitForTimeout(3000);

    await expect(page.getByTestId("add-ride-back-733")).toBeVisible({ timeout: 5000 });

    const postCancelRiderCount = getRiderCount(driverAssignmentId!);
    expect(postCancelRiderCount).toBe(initialRiderCount - 1);
  });

  test("Add ride back from Today card re-creates DB row", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const today = todayStrSF();
    const dow = new Date(today + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) { test.skip(); return; }

    const coord = setupHousehold(40, "AddBackCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(41, "AddBackDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(42, "AddBackParent", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds, dates } = setupCurrentWeekWithTrips();
    const todayIdx = dates.indexOf(today);
    if (todayIdx < 0) { test.skip(); return; }
    const morningTrip = tripIds[todayIdx * 2];

    runSql(`
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(741)}', '${GROUP_ID}', '${driver.householdId}', 'AddBackCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(742)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(743)}', '${GROUP_ID}', '${rider.householdId}', 'AddBack', 'Child', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(744)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(745)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(744)}', '${morningTrip}', '${UID(742)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(745)}', '${morningTrip}', '${UID(743)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(744)}', '${morningTrip}', '${driver.userId}', '${UID(741)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    const genResult = generateSchedule(coord.email, weekId);
    expect(genResult.success).toBe(true);
    publishScheduleViaSql(weekId);

    const driverAssignmentId = getDriverAssignmentId(weekId, morningTrip);
    expect(driverAssignmentId).not.toBeNull();

    await signInWithTestAuth(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("today-card")).toBeVisible({ timeout: 5000 });

    // Cancel first
    const cancelBtn = page.getByTestId("cancel-ride-743");
    await cancelBtn.click();
    await page.getByTestId("confirm-cancel-ride-743").click();
    await page.waitForTimeout(3000);
    await expect(page.getByTestId("add-ride-back-743")).toBeVisible({ timeout: 5000 });
    expect(getRiderCount(driverAssignmentId!)).toBe(1);

    // Add back
    const addBackBtn = page.getByTestId("add-ride-back-743");
    await addBackBtn.click();
    await page.waitForTimeout(3000);
    await expect(page.getByTestId("cancel-ride-743")).toBeVisible({ timeout: 5000 });
    expect(getRiderCount(driverAssignmentId!)).toBe(2);
  });

  test("Driver's This Week roster reflects rider cancellation", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const today = todayStrSF();
    const dow = new Date(today + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) { test.skip(); return; }

    const coord = setupHousehold(50, "RosterCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(51, "RosterDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(52, "RosterParent", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds, dates } = setupCurrentWeekWithTrips();
    const todayIdx = dates.indexOf(today);
    if (todayIdx < 0) { test.skip(); return; }
    const morningTrip = tripIds[todayIdx * 2];

    runSql(`
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(751)}', '${GROUP_ID}', '${driver.householdId}', 'RosterCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(752)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(753)}', '${GROUP_ID}', '${rider.householdId}', 'Roster', 'Child', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(754)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(755)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(754)}', '${morningTrip}', '${UID(752)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(755)}', '${morningTrip}', '${UID(753)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(754)}', '${morningTrip}', '${driver.userId}', '${UID(751)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    const genResult = generateSchedule(coord.email, weekId);
    expect(genResult.success).toBe(true);
    publishScheduleViaSql(weekId);

    const driverAssignmentId = getDriverAssignmentId(weekId, morningTrip);
    expect(driverAssignmentId).not.toBeNull();

    // Cancel the rider's ride
    const riderTokenBody = JSON.stringify({ email: rider.email, password: TEST_PASSWORD });
    const riderTokenResult = execSync(
      `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '${riderTokenBody}' "${SUPABASE_URL}/auth/v1/token?grant_type=password"`,
      { encoding: "utf8" },
    );
    const riderJwt = JSON.parse(riderTokenResult).access_token;
    execSync(
      `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${riderJwt}" -H "Content-Type: application/json" -d '{"p_child_id":"${UID(753)}","p_driver_assignment_id":"${driverAssignmentId}"}' "${SUPABASE_URL}/rest/v1/rpc/cancel_ride_for_child"`,
      { encoding: "utf8" },
    );

    // Sign in as driver and check This Week tab
    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });

    const rosterSection = page.locator('[data-testid^="drive-card-"]').first();
    await expect(rosterSection).toBeVisible({ timeout: 5000 });
    await rosterSection.click();
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".child-photo-card")).not.toHaveCount(0);
  });
});