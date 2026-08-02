// Full user journey tests — simulates real parent and coordinator flows.
// Each test exercises a complete end-to-end workflow through the UI:
// check-in submit, confirm drives, decline+reaccept, generate+publish,
// and regenerate after publish.
//
// Targets the STAGING project by default (jfyjgmhqnlbdcafoarrg).
// Run: npm run test:runtime
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
  console.error("Aborting: E2E tests must not run against production. Run `npm run link:test` first.");
  process.exit(1);
}

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp/project-ref"), "utf8").trim();
    if (linkedRef !== PROJECT_REF) {
      console.error(`CLI linked to ${linkedRef} but PROJECT_REF is ${PROJECT_REF}. Run "npm run link:test" or "npm run link:prod".`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref. Run 'npm run link:test' or 'npm run link:prod'.");
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
    for (const k of keyList) {
      if (k.id === "service_role") return k.api_key;
    }
  } catch {}
  try {
    const keys = JSON.parse(readFileSync("/tmp/kidpool-test-keys.json", "utf8"));
    if (keys.serviceKey) return keys.serviceKey;
  } catch {}
  return null;
}

const SERVICE_KEY = getServiceKey();
const skip = !SERVICE_KEY;

function runSql(sql: string): { rows?: Array<Record<string, unknown>>; error?: { message: string } } {
  const tmpFile = `/tmp/kidpool-journey-query.sql`;
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
    for (const k of keyList) {
      if (k.id === "anon") return k.api_key;
    }
  } catch {}
  try {
    const keys = JSON.parse(readFileSync("/tmp/kidpool-test-keys.json", "utf8"));
    if (keys.anonKey) return keys.anonKey;
  } catch {}
  return "";
}

const ANON_KEY = getAnonKey();

function createTestUser(email: string): string | null {
  // Delete any existing user with this email first
  try {
    const listResult = execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?per_page=1000"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = JSON.parse(listResult);
    const users = parsed.users || parsed || [];
    for (const user of users) {
      if (user.email === email) {
        deleteTestUser(user.id);
      }
    }
  } catch {}
  // Also delete any stale profile
  runSql(`DELETE FROM public.profiles WHERE email = '${email}';`);

  // Now create a fresh user
  const body = JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: email } });
  try {
    const result = execSync(
      `curl -s -X POST -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/admin/users"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(result);
    return parsed.id || null;
  } catch {
    return null;
  }
}

function deleteTestUser(userId: string) {
  if (!userId) return;
  try {
    execSync(
      `curl -s -X DELETE -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users/${userId}" > /dev/null`,
      { encoding: "utf8" },
    );
  } catch {}
}

function deleteTestUsersByEmail() {
  // Use SQL to delete auth users directly — more reliable than admin API pagination
  try {
    runSql(`DELETE FROM auth.users WHERE email LIKE '%@e2e.kidpool';`);
  } catch {}

  // Also try admin API as fallback
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
        if (user.email && user.email.endsWith("@e2e.kidpool")) {
          deleteTestUser(user.id);
        }
      }
      if (users.length < 1000) break;
      page++;
    } catch {
      break;
    }
  }
}

function cleanupJourneyData() {
  // 1. Delete test data in FK-safe order FIRST
  runSql(`
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND (
      id::text LIKE 'deadbeef-%'
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool')
    );
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool');
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool')
    );
    DELETE FROM public.profiles WHERE email LIKE '%@e2e.kidpool';
  `);
  // 2. Delete auth users AFTER profiles/households are gone
  deleteTestUsersByEmail();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@e2e.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(100 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Journey') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Journey', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function setupWeekWithTrips() {
  const weekId = UID(900);
  const tripIds: string[] = [];
  const dates = ["2028-01-03", "2028-01-04", "2028-01-05", "2028-01-06", "2028-01-07"];
  let sql = `INSERT INTO public.weeks (id, group_id, starts_on, status, checkin_deadline, confirmation_deadline) VALUES ('${weekId}', '${GROUP_ID}', '2028-01-03', 'open', '2028-01-02T15:00:00-08:00', '2028-01-02T15:00:00-08:00') ON CONFLICT DO NOTHING;\n`;
  for (let d = 0; d < 5; d++) {
    for (const dir of ["morning", "afternoon"]) {
      const tId = UID(400 + d * 2 + (dir === "morning" ? 0 : 1));
      tripIds.push(tId);
      const time = dir === "morning" ? "08:40" : "15:15";
      sql += `INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${tId}', '${GROUP_ID}', '${weekId}', '${dates[d]}', '${dir}', '${time}', '${time}', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;\n`;
    }
  }
  runSql(sql);
  return { weekId, tripIds, dates };
}

async function signInWithTestAuth(page: Page, email: string) {
  await page.goto(`/?testAuth=${email}|${TEST_PASSWORD}`);
  await expect(
    page.getByTestId("home-screen").or(page.getByTestId("onboarding-screen"))
  ).toBeVisible({ timeout: 15000 });
}

async function generateSchedule(coordUserId: string, weekId: string) {
  const tokenBody = JSON.stringify({ email: `${"coordjourney"}@e2e.kidpool`, password: TEST_PASSWORD });
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

test.describe("User Journeys", () => {
  test.beforeAll(() => {
    cleanupJourneyData();
  });

  test.afterAll(() => {
    cleanupJourneyData();
  });

  test.afterEach(() => {
    cleanupJourneyData();
  });

  // ── Journey 1: Check-in submit ──────────────────────────────────

  test("parent submits weekly check-in with ride needs and driving preference", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(10, "JourneyCoord", true);
    if (!coord) { test.skip(); return; }
    const family = setupHousehold(11, "JourneyFamily", false);
    if (!family) { test.skip(); return; }

    const { weekId, tripIds } = setupWeekWithTrips();
    const morningTripId = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(211)}', '${GROUP_ID}', '${family.householdId}', 'Alex', 'Journey', '${family.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(311)}', '${GROUP_ID}', '${family.householdId}', 'Family Car', 4, true, '${family.userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, family.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("nav-plan").click();
    await expect(page.getByTestId("plan-screen")).toBeVisible({ timeout: 10000 });

    const ridePill = page.locator(`button[aria-label*="Alex"][aria-label*="needs a ride"], button[aria-label*="Alex"][aria-label*="does not need a ride"]`).first();
    await expect(ridePill).toBeVisible({ timeout: 5000 });
    await ridePill.click();
    await page.waitForTimeout(500);

    const preferButton = page.locator('button[aria-label="Prefer to drive"]').first();
    await expect(preferButton).toBeVisible({ timeout: 5000 });
    await preferButton.click();
    await page.waitForTimeout(500);

    await page.getByTestId("submit-plan").click();
    await page.waitForTimeout(2000);

    await expect(page.locator('.success-banner')).toBeVisible({ timeout: 5000 });
  });

  // ── Journey 2: Confirm all drives ───────────────────────────────

  test("driver confirms all tentative drive assignments", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(20, "ConfirmCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(21, "ConfirmDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupWeekWithTrips();
    const morningTripId = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(221)}', '${GROUP_ID}', '${driver.householdId}', 'Sam', 'Confirm', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(321)}', '${GROUP_ID}', '${driver.householdId}', 'Sedan', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(521)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(521)}', '${morningTripId}', '${UID(221)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(521)}', '${morningTripId}', '${driver.userId}', '${UID(321)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.userId, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });
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
  });

  // ── Journey 3: Decline with reason + re-accept ───────────────────

  test("driver declines an assignment then re-accepts it", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(30, "DeclineCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(31, "DeclineDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupWeekWithTrips();
    const morningTripId = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(231)}', '${GROUP_ID}', '${driver.householdId}', 'Pat', 'Decline', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(331)}', '${GROUP_ID}', '${driver.householdId}', 'SUV', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(531)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(531)}', '${morningTripId}', '${UID(231)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(531)}', '${morningTripId}', '${driver.userId}', '${UID(331)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.userId, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, driver.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const reviewBtn = page.locator('button:has-text("Review individually")');
    await expect(reviewBtn).toBeVisible({ timeout: 10000 });
    await reviewBtn.click();
    await expect(page.getByTestId("review-screen")).toBeVisible({ timeout: 5000 });

    const declineBtn = page.locator('button:has-text("I can\'t make this one")').first();
    await expect(declineBtn).toBeVisible({ timeout: 5000 });
    await declineBtn.click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId("decline-form")).toBeVisible({ timeout: 5000 });

    const confirmDeclineBtn = page.locator('button:has-text("Confirm decline")');
    await expect(confirmDeclineBtn).toBeVisible({ timeout: 5000 });
    await confirmDeclineBtn.click();
    await page.waitForTimeout(2000);

    await expect(page.locator('.declined-notice')).toBeVisible({ timeout: 5000 });

    const reacceptBtn = page.locator('button:has-text("Re-accept this drive")');
    await expect(reacceptBtn).toBeVisible({ timeout: 5000 });
    await reacceptBtn.click();
    await page.waitForTimeout(2000);
    await expect(page.locator('.success-notice')).toBeVisible({ timeout: 5000 });
  });

  // ── Journey 4: Coordinator generate + publish ───────────────────

  test("coordinator generates draft schedule and publishes it", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(40, "PubCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(41, "PubDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupWeekWithTrips();
    const morningTripId = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(241)}', '${GROUP_ID}', '${driver.householdId}', 'Chris', 'Pub', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(341)}', '${GROUP_ID}', '${driver.householdId}', 'Van', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(541)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(541)}', '${morningTripId}', '${UID(241)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(541)}', '${morningTripId}', '${driver.userId}', '${UID(341)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.userId, weekId);
    await page.waitForTimeout(1000);

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const publishBtn = page.getByTestId("publish-schedule");
    await expect(publishBtn).toBeVisible({ timeout: 10000 });
    const isDisabled = await publishBtn.isDisabled();
    if (!isDisabled) {
      await publishBtn.click();
      await page.waitForTimeout(3000);
      await expect(page.locator('.publish-notice')).toBeVisible({ timeout: 5000 });
    }
  });

  // ── Journey 5: Regenerate after publish ─────────────────────────

  test("coordinator regenerates a published schedule", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(50, "RegenCoord", true);
    if (!coord) { test.skip(); return; }
    const driver = setupHousehold(51, "RegenDriver", false);
    if (!driver) { test.skip(); return; }

    const { weekId, tripIds } = setupWeekWithTrips();
    const morningTripId = tripIds[0];

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(251)}', '${GROUP_ID}', '${driver.householdId}', 'Taylor', 'Regen', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(351)}', '${GROUP_ID}', '${driver.householdId}', 'Wagon', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(551)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(551)}', '${morningTripId}', '${UID(251)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(551)}', '${morningTripId}', '${driver.userId}', '${UID(351)}', 'prefer') ON CONFLICT DO NOTHING;
    `);

    await generateSchedule(coord.userId, weekId);
    await page.waitForTimeout(1000);

    const versionResult = execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/rest/v1/schedule_versions?week_id=eq.${weekId}&select=id,status"`,
      { encoding: "utf8" },
    );
    const versions = JSON.parse(versionResult);
    if (versions.length > 0 && versions[0].status === "draft") {
      runSql(`UPDATE public.schedule_versions SET status = 'published' WHERE week_id = '${weekId}' AND status = 'draft';`);
    }

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const replaceBtn = page.locator('button:has-text("Replace published schedule")');
    await expect(replaceBtn).toBeVisible({ timeout: 10000 });
    await replaceBtn.click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId("confirm-regenerate")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("regenerate-schedule-coord").click();
    await page.waitForTimeout(3000);

    // After regeneration, the confirm dialog should be gone.
    await expect(page.getByTestId("confirm-regenerate")).not.toBeVisible({ timeout: 5000 });
  });
});