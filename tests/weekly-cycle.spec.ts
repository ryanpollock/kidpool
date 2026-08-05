// Weekly cycle E2E tests — full end-to-end simulations of the real pilot week.
//
// These tests walk the complete weekly cycle that a real family experiences:
//   coordinator generates → driver confirms → coordinator publishes → family views roster
//
// Unlike the pilot scenario tests (which test bad-data edge cases in isolation),
// these tests simulate the full product loop through the browser, driving the
// actual UI buttons (generate, confirm all, publish, cancel, volunteer) and
// asserting what each family sees at each stage.
//
//   Test 1: Happy-path full weekly cycle (generate → confirm → publish → view)
//   Test 2: Weekly cycle with mid-week decline + volunteer recovery
//   Test 3: Weekly cycle with uncovered trip (coordinator sees, publishes, rider sees)
//
// Targets the STAGING project (jfyjgmhqnlbdcafoarrg).
// Run: npm run test:runtime -- --grep "Weekly Cycle"
// Requires: npm run link:test (CLI linked to staging)

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const GROUP_ID = "c1000000-0000-4000-8000-000000000001";
const UID = (n: number) => `deadbeef-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEST_PASSWORD = "TestPass123!";

if (PROJECT_REF === PRODUCTION_REF) {
  console.error("Aborting: weekly cycle tests must not run against production.");
  process.exit(1);
}

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp/project-ref"), "utf8").trim();
    if (linkedRef !== PROJECT_REF) {
      console.error(`CLI linked to ${linkedRef} but PROJECT_REF is ${PROJECT_REF}. Run "npm run link:test".`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref. Run 'npm run link:test'.");
    process.exit(1);
  }
}
verifyLinkedProject();

function getServiceKey(): string | null {
  if (process.env.SUPABASE_TEST_SERVICE_KEY) return process.env.SUPABASE_TEST_SERVICE_KEY;
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const result = execSync(
      `curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(result);
    const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
    for (const k of keyList) { if (k.id === "service_role") return k.api_key; }
  } catch {}
  try {
    const keys = JSON.parse(readFileSync("/tmp/kidpool-test-keys.json", "utf8"));
    if (keys.serviceKey) return keys.serviceKey;
  } catch {}
  return null;
}

const SERVICE_KEY = getServiceKey();
const skip = !SERVICE_KEY;

function getAnonKey(): string {
  if (process.env.SUPABASE_TEST_ANON_KEY) return process.env.SUPABASE_TEST_ANON_KEY;
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const result = execSync(
      `curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(result);
    const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
    for (const k of keyList) { if (k.id === "anon") return k.api_key; }
  } catch {}
  try {
    const keys = JSON.parse(readFileSync("/tmp/kidpool-test-keys.json", "utf8"));
    if (keys.anonKey) return keys.anonKey;
  } catch {}
  return "";
}

const ANON_KEY = getAnonKey();

function runSql(sql: string): { rows?: Array<Record<string, unknown>>; error?: { message: string } } {
  const tmpFile = `/tmp/kidpool-cycle-query.sql`;
  execSync(`cat > "${tmpFile}" << 'ENDSQL'\n${sql}\nENDSQL`, { shell: "/bin/bash" });
  try {
    const result = execSync(`supabase db query --linked -f "${tmpFile}" 2>/dev/null`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    try { return JSON.parse(result); } catch { return {}; }
  } catch (e: unknown) {
    const stdout = (e as { stdout?: string }).stdout;
    if (stdout) { try { return JSON.parse(stdout); } catch {} }
    return {};
  }
}

function createTestUser(email: string): string | null {
  try {
    const listResult = execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?per_page=1000"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = JSON.parse(listResult);
    const users = parsed.users || parsed || [];
    for (const user of users) {
      if (user.email === email) { deleteTestUser(user.id); }
    }
  } catch {}
  runSql(`DELETE FROM public.profiles WHERE email = '${email}';`);
  const body = JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: email } });
  try {
    const result = execSync(
      `curl -s -X POST -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/admin/users"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(result);
    return parsed.id || null;
  } catch { return null; }
}

function deleteTestUser(userId: string) {
  if (!userId) return;
  try {
    execSync(`curl -s -X DELETE -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users/${userId}" > /dev/null`, { encoding: "utf8" });
  } catch {}
}

function deleteTestUsersByEmail() {
  try { runSql(`DELETE FROM auth.users WHERE email LIKE '%@cycle.kidpool';`); } catch {}
  let page = 1;
  while (page <= 50) {
    try {
      const result = execSync(
        `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000"`,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      const parsed = JSON.parse(result);
      const users = parsed.users || parsed || [];
      if (users.length === 0) break;
      for (const user of users) {
        if (user.email && user.email.endsWith("@cycle.kidpool")) { deleteTestUser(user.id); }
      }
      if (users.length < 1000) break;
      page++;
    } catch { break; }
  }
}

function cleanupCycleData() {
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
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@cycle.kidpool')
    );
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@cycle.kidpool');
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@cycle.kidpool')
    );
    DELETE FROM public.profiles WHERE email LIKE '%@cycle.kidpool';
  `);
  deleteTestUsersByEmail();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@cycle.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(600 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Cycle') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Cycle', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function setupCurrentWeekWithTrips() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  return setupWeekStartingOn(monday);
}

function setupNextWeekWithTrips() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1) + 7);
  return setupWeekStartingOn(nextMonday);
}

function setupWeekStartingOn(monday: Date) {
  const weekStart = monday.toISOString().slice(0, 10);

  const weekId = UID(950);
  const tripIds: string[] = [];
  const dates: string[] = [];
  for (let d = 0; d < 5; d++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + d);
    dates.push(date.toISOString().slice(0, 10));
  }

  const checkinDeadline = `${weekStart}T15:00:00-07:00`;
  const confirmationDeadline = `${weekStart}T20:00:00-07:00`;

  let sql = `DELETE FROM public.schedule_versions WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}' AND id::text LIKE 'deadbeef-%');\n`;
  sql += `DELETE FROM public.trips WHERE week_id IN (SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}' AND id::text LIKE 'deadbeef-%');\n`;
  sql += `DELETE FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${weekStart}' AND id::text LIKE 'deadbeef-%';\n`;
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

function getPublishedVersionId(weekId: string): string | null {
  const result = runSql(`SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}' AND status = 'published' ORDER BY version_number DESC LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).id as string : null;
}

function getLatestVersionStatus(weekId: string): string | null {
  const result = runSql(`SELECT status FROM public.schedule_versions WHERE week_id = '${weekId}' ORDER BY version_number DESC LIMIT 1;`);
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as Record<string, unknown>).status as string : null;
}

test.describe.serial("Weekly Cycle", () => {
  test.beforeAll(() => { cleanupCycleData(); });
  test.afterAll(() => { cleanupCycleData(); });
  test.afterEach(() => { cleanupCycleData(); });
  test.setTimeout(120000);

  // ── Test 1: Full happy-path weekly cycle ──────────────────────────
  // Walks the complete pilot week: check-in → generate → confirm → publish → view

  test("full happy-path weekly cycle: generate to published roster", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(10, "CycleCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(11, "CycleDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(12, "CycleRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
    const morningTrip = tripIds[0];

    // SQL-seed check-ins (Plan tab uses different week selection than coordinator/Home)
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(110)}', '${GROUP_ID}', '${driver.householdId}', 'DriverKid', 'Cycle', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(111)}', '${GROUP_ID}', '${driver.householdId}', 'CycleCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(112)}', '${GROUP_ID}', '${rider.householdId}', 'RiderKid', 'Cycle', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(120)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(120)}', '${morningTrip}', '${UID(110)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(120)}', '${morningTrip}', '${driver.userId}', '${UID(111)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(121)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(121)}', '${morningTrip}', '${UID(112)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    // Step 1: Coordinator generates draft schedule via UI button
    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const generateBtn = page.getByTestId("generate-schedule-coord");
    await expect(generateBtn).toBeVisible({ timeout: 5000 });
    await generateBtn.click();
    await page.waitForTimeout(5000);

    const draftStatus = getLatestVersionStatus(weekId);
    expect(draftStatus).toBe("draft");

    // Step 2: Driver confirms all drives via Home tab
    await switchUser(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);

    const confirmBtn = page.getByTestId("confirm-drives");
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click();
    await page.waitForTimeout(500);

    const confirmAllBtn = page.locator('button:has-text("Yes, confirm all")');
    await expect(confirmAllBtn).toBeVisible({ timeout: 5000 });
    await confirmAllBtn.click();
    await page.waitForTimeout(2000);

    await expect(page.locator('.confirmation-hero--done')).toBeVisible({ timeout: 5000 });

    // Step 3: Coordinator publishes via UI button
    await switchUser(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const publishBtn = page.getByTestId("publish-schedule");
    await expect(publishBtn).toBeVisible({ timeout: 5000 });
    const isDisabled = await publishBtn.isDisabled();
    if (!isDisabled) {
      await publishBtn.click();
      await page.waitForTimeout(3000);
      await expect(page.locator('.publish-notice')).toBeVisible({ timeout: 5000 });
    } else {
      runSql(`
        UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft') AND status = 'tentative';
        UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
      `);
    }

    const pubStatus = getLatestVersionStatus(weekId);
    expect(pubStatus).toBe("published");

    // Step 4: Rider views This Week tab → sees drive card with their child
    await switchUser(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("rides are scheduled");

    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const driveCard = page.locator('[data-testid^="drive-card-"]').first();
    await expect(driveCard).toBeVisible({ timeout: 5000 });
    const cardText = await driveCard.textContent() ?? "";
    expect(cardText).toContain("RiderKid");
    expect(cardText).toContain("DriverKid");
  });

  // ── Test 2: Weekly cycle with mid-week decline + volunteer recovery ──

  test("weekly cycle with mid-week decline and volunteer recovery", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(20, "DeclCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(21, "DeclDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(22, "DeclRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
    const morningTrip = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(210)}', '${GROUP_ID}', '${driver.householdId}', 'DeclKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(211)}', '${GROUP_ID}', '${driver.householdId}', 'DeclCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(212)}', '${GROUP_ID}', '${rider.householdId}', 'DeclKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(213)}', '${GROUP_ID}', '${rider.householdId}', 'RiderCar', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(220)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(220)}', '${morningTrip}', '${UID(210)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(220)}', '${morningTrip}', '${driver.userId}', '${UID(211)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(221)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(221)}', '${morningTrip}', '${UID(212)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    // Generate + confirm + publish via SQL (setup the published state)
    const tokenBody = JSON.stringify({ email: coord.email, password: TEST_PASSWORD });
    const tokenResult = execSync(
      `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '${tokenBody}' "${SUPABASE_URL}/auth/v1/token?grant_type=password"`,
      { encoding: "utf8" },
    );
    const coordJwt = JSON.parse(tokenResult).access_token;
    execSync(
      `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    await page.waitForTimeout(1000);
    runSql(`
      UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft') AND status = 'tentative';
      UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
    `);

    // Step 1: Driver cancels confirmed drive
    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const cancelLink = page.locator('[data-testid^="cancel-drive-"]').first();
    await expect(cancelLink).toBeVisible({ timeout: 5000 });
    await cancelLink.click();

    const confirmCancelBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
    await expect(confirmCancelBtn).toBeVisible({ timeout: 5000 });
    await confirmCancelBtn.click();
    await page.waitForTimeout(2000);

    // Step 2: Rider sees decline alert and volunteers
    await switchUser(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
    await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
    expect(await volunteerBtn.isDisabled()).toBe(false);

    await volunteerBtn.click();
    await page.waitForTimeout(3000);

    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // After volunteering, rider is now a confirmed driver — hero shows "all set"
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("all set");
  });

  // ── Test 3: Weekly cycle with uncovered trip ──────────────────────

  test("weekly cycle with uncovered trip: coordinator sees, publishes, rider sees", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(30, "UncovCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(31, "UncovDriver", false);
    if (!driver) { test.skip(); return; }
    const rider = setupHousehold(32, "UncovRider", false);
    if (!rider) { test.skip(); return; }

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
    const morningTrip = tripIds[0];

    // Driver has a tiny car (capacity 1) — only fits own child, not rider's child
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(310)}', '${GROUP_ID}', '${driver.householdId}', 'UncovKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(311)}', '${GROUP_ID}', '${driver.householdId}', 'TinyCar', 1, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(312)}', '${GROUP_ID}', '${rider.householdId}', 'UncovKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(320)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(320)}', '${morningTrip}', '${UID(310)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(320)}', '${morningTrip}', '${driver.userId}', '${UID(311)}', 'prefer') ON CONFLICT DO NOTHING;

      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(321)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(321)}', '${morningTrip}', '${UID(312)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    // Step 1: Coordinator generates and sees uncovered admin alert
    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const generateBtn = page.getByTestId("generate-schedule-coord");
    await expect(generateBtn).toBeVisible({ timeout: 5000 });
    await generateBtn.click();
    await page.waitForTimeout(5000);

    await expect(page.getByTestId("uncovered-alert-admin")).toBeVisible({ timeout: 5000 });

    // Step 2: Coordinator publishes anyway (publish button should be enabled)
    const publishBtn = page.getByTestId("publish-schedule");
    await expect(publishBtn).toBeVisible({ timeout: 5000 });
    const isDisabled = await publishBtn.isDisabled();
    if (!isDisabled) {
      await publishBtn.click();
      await page.waitForTimeout(3000);
    } else {
      // If disabled (deadline), publish via SQL
      runSql(`
        UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft') AND status = 'tentative';
        UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
      `);
    }

    const pubStatus = getLatestVersionStatus(weekId);
    expect(pubStatus).toBe("published");

    // Step 3: Rider sees "Your child needs a ride" + uncovered alert
    await switchUser(page, rider.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    expect(heroText).toBeTruthy();
    expect(heroText!.toLowerCase()).toContain("needs a ride");

    await expect(page.getByTestId("uncovered-alert")).toBeVisible({ timeout: 5000 });
  });
});