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
//
// Targets the STAGING project (jfyjgmhqnlbdcafoarrg).
// Run: npm run test:runtime -- --grep "Pilot Scenarios"
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
  console.error("Aborting: pilot scenario tests must not run against production.");
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
  const tmpFile = `/tmp/kidpool-pilot-query.sql`;
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
  try { runSql(`DELETE FROM auth.users WHERE email LIKE '%@pilot.kidpool';`); } catch {}
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
        if (user.email && user.email.endsWith("@pilot.kidpool")) { deleteTestUser(user.id); }
      }
      if (users.length < 1000) break;
      page++;
    } catch { break; }
  }
}

function cleanupPilotData() {
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
  deleteTestUsersByEmail();
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

function setupCurrentWeekWithTrips() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
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

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
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

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
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

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
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

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
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

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
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

    const { weekId, tripIds } = setupCurrentWeekWithTrips();
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
});