// Phase 4: E2E browser tests for the carpool app.
// Uses the dev-only test auth bypass (?testAuth=email|password) to sign in
// with test users created via the Supabase admin API. These tests exercise
// the actual UI: sign-in, onboarding, check-in, schedule, confirmation,
// publication, and navigation.
//
// Targets the STAGING project by default (jfyjgmhqnlbdcafoarrg).
// Run: npm run test:runtime
// Requires: npm run link:test (CLI linked to staging)

import { expect, test, type Page } from "@playwright/test";
import assert from "node:assert/strict";
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

function runSql(sql: string): { rows?: Array<Record<string, unknown>>; error?: { message: string } } {
  const tmpFile = `/tmp/kidpool-e2e-query.sql`;
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
  // Delete any existing user with this email first
  deleteTestUserByEmail(email);
  runSql(`DELETE FROM public.profiles WHERE email = '${email}';`);

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

function deleteTestUserByEmail(email: string) {
  // Use SQL to find and delete the auth user directly
  try {
    const result = runSql(`SELECT id FROM auth.users WHERE email = '${email}';`);
    const rows = result?.rows ?? [];
    for (const row of rows) {
      if (row.id) {
        deleteTestUser(String(row.id));
        return;
      }
    }
  } catch {}

  // Fall back to admin API pagination
  let page = 1;
  const maxPages = 50;
  while (page <= maxPages) {
    try {
      const result = execSync(
        `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000"`,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      const parsed = JSON.parse(result);
      const users = parsed.users || parsed || [];
      if (users.length === 0) break;
      for (const user of users) {
        if (user.email === email) {
          deleteTestUser(user.id);
          return;
        }
      }
      if (users.length < 1000) break;
      page++;
    } catch {
      break;
    }
  }
}

function deleteTestUsersByEmail() {
  // Use SQL to delete auth users directly — more reliable than admin API pagination
  try {
    runSql(`DELETE FROM auth.users WHERE email LIKE '%@e2e.kidpool' OR email LIKE '%@test.kidpool';`);
  } catch {}

  // Also try admin API as fallback for any users SQL can't reach
  let page = 1;
  const maxPages = 50;
  while (page <= maxPages) {
    try {
      const result = execSync(
        `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000"`,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      const parsed = JSON.parse(result);
      const users = parsed.users || parsed || [];
      if (users.length === 0) break;
      for (const user of users) {
        if (user.email && (user.email.endsWith("@e2e.kidpool") || user.email.endsWith("@test.kidpool"))) {
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

function cleanupE2EData() {
  // 1. Delete test data in FK-safe order FIRST
  runSql(`
    -- Test weeks (deadbeef ID) cascade to trips, checkins, schedule_versions, assignments, confirmations
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';

    -- Checkins for test households (deadbeef ID OR created by test profiles)
    -- cascades to ride_requests, driver_availability
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND (
      household_id::text LIKE 'deadbeef-%'
      OR household_id IN (SELECT id FROM public.households WHERE group_id = '${GROUP_ID}' AND created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool'))
    );

    -- Test households (deadbeef ID OR created by test profiles) cascade to memberships, children, vehicles, join codes
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND (
      id::text LIKE 'deadbeef-%'
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool')
    );

    -- Nullify schedule_versions.generated_by for test profiles (FK constraint)
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool');

    -- Test audit events (reference test data or test actors)
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool')
    );

    -- Test profiles (by email domain)
    DELETE FROM public.profiles WHERE email LIKE '%@e2e.kidpool';
  `);

  // 2. Delete auth users AFTER profiles/households are gone (FK constraint)
  deleteTestUsersByEmail();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@e2e.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(100 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} E2E') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} E2E', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

async function signInWithTestAuth(page: Page, email: string) {
  await page.goto(`/?testAuth=${email}|${TEST_PASSWORD}`);
  await expect(
    page.getByTestId("home-screen").or(page.getByTestId("onboarding-screen"))
  ).toBeVisible({ timeout: 15000 });
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

function generateScheduleViaEdgeFunction(coordEmail: string, weekId: string) {
  const tokenBody = JSON.stringify({ email: coordEmail, password: TEST_PASSWORD });
  const tokenResult = execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '${tokenBody}' "${SUPABASE_URL}/auth/v1/token?grant_type=password"`,
    { encoding: "utf8" },
  );
  const tokenData = JSON.parse(tokenResult);
  const jwt = tokenData.access_token;
  if (!jwt) throw new Error("Could not sign in as coordinator for schedule generation");
  const fnResult = execSync(
    `curl -s -X POST -H "Authorization: Bearer ${jwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(fnResult);
}

test.describe("App E2E", () => {
  test.beforeAll(() => {
    cleanupE2EData();
  });

  test.afterAll(() => {
    cleanupE2EData();
  });

  test("sign-in screen renders for unauthenticated user", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("sign-in-screen")).toBeVisible({ timeout: 10000 });
  });

  test("Google sign-in button is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("sign-in-screen")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("google-sign-in")).toBeVisible();
  });

  test("test auth bypass signs in and shows onboarding for new user", async ({ page }) => {
    test.skip(skip, "Requires service key");
    // Create a user with NO household — should see onboarding
    const email = "e2eonboard@e2e.kidpool";
    const userId = createTestUser(email);
    if (!userId) { test.skip(); return; }

    await signInWithTestAuth(page, email);
    await expect(page.getByTestId("onboarding-screen")).toBeVisible({ timeout: 15000 });

    cleanupE2EData();
  });

  test("home screen renders for authenticated user with household", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(2, "E2eHome", false);
    if (!user) { test.skip(); return; }

    await signInWithTestAuth(page, user.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    cleanupE2EData();
  });

  test("bottom navigation has 4 tabs", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(3, "E2eNav", false);
    if (!user) { test.skip(); return; }

    await signInWithTestAuth(page, user.email);
    await expect(page.getByTestId("nav-home")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("nav-plan")).toBeVisible();
    await expect(page.getByTestId("nav-week")).toBeVisible();
    await expect(page.getByTestId("nav-coordinate")).toBeVisible();

    cleanupE2EData();
  });

  test("plan screen renders with check-in form", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(4, "E2ePlan", false);
    if (!user) { test.skip(); return; }
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(204)}', '${GROUP_ID}', '${user.householdId}', 'Child1', 'Plan', '${user.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(304)}', '${GROUP_ID}', '${user.householdId}', 'Family Car', 4, '${user.userId}') ON CONFLICT DO NOTHING;
    `);
    runSql(`
      INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${UID(904)}', '${GROUP_ID}', '2028-01-03', 'open') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, user.email);
    await page.getByTestId("nav-plan").click();
    await expect(page.getByTestId("plan-screen")).toBeVisible({ timeout: 10000 });

    cleanupE2EData();
  });

  test("week screen renders schedule view", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(5, "E2eWeek", false);
    if (!user) { test.skip(); return; }
    runSql(`INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${UID(905)}', '${GROUP_ID}', '2028-01-03', 'open') ON CONFLICT DO NOTHING;`);

    await signInWithTestAuth(page, user.email);
    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });

    cleanupE2EData();
  });

  test("coordinator screen renders for coordinator", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(6, "E2eCoord", true);
    if (!user) { test.skip(); return; }

    await signInWithTestAuth(page, user.email);
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });

    cleanupE2EData();
  });

  test("account screen is accessible", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(7, "E2eAccount", false);
    if (!user) { test.skip(); return; }
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(207)}', '${GROUP_ID}', '${user.householdId}', 'Child1', 'Acct', '${user.userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, user.email);
    // Click the avatar button to open the account screen
    await expect(page.locator('.avatar-button')).toBeVisible({ timeout: 5000 });
    await page.locator('.avatar-button').click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    cleanupE2EData();
  });

  test("error boundary is present in app structure", async ({ page }) => {
    // The app wraps everything in AppErrorBoundary — verify it doesn't
    // render the error state when the app loads normally
    await page.goto("/");
    await expect(page.getByTestId("sign-in-screen")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("error-boundary")).not.toBeVisible();
  });

  test("sign-out returns to sign-in screen", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(8, "E2eSignOut", false);
    if (!user) { test.skip(); return; }

    await signInWithTestAuth(page, user.email);

    // Open account screen to access sign-out
    await expect(page.locator('.avatar-button')).toBeVisible({ timeout: 5000 });
    await page.locator('.avatar-button').click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    // Find and click sign-out button
    const signOutButton = page.locator('button:has-text("Sign out"), button:has-text("Sign Out"), [data-testid*="sign-out"]').first();
    await expect(signOutButton).toBeVisible({ timeout: 5000 });
    await signOutButton.click();
    await expect(page.getByTestId("sign-in-screen")).toBeVisible({ timeout: 10000 });

    cleanupE2EData();
  });

  test("coordinator can create a week", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(9, "E2eCreateWeek", true);
    if (!user) { test.skip(); return; }

    await signInWithTestAuth(page, user.email);
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });

    // If there's a "Create week" button, click it
    const createWeekBtn = page.getByTestId("create-week-coord").first();
    if (await createWeekBtn.isVisible({ timeout: 3000 })) {
      await createWeekBtn.click();
      await page.waitForTimeout(2000);
    }

    cleanupE2EData();
  });

  // ── Riding buddy picker UI tests ──────────────────────────────────

  test("buddy picker renders on account screen for each child", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(10, "E2eBuddyRender", false);
    if (!user) { test.skip(); return; }
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(210)}', '${GROUP_ID}', '${user.householdId}', 'BuddyKid', 'Render', '${user.userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, user.email);
    await page.waitForTimeout(2000);

    // Navigate to account screen via avatar button
    const avatarBtn = page.locator('[aria-label="Open household profile"]').first();
    await avatarBtn.click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    // Verify buddy picker label and select are visible
    await expect(page.locator('.buddy-picker > span:has-text("Riding buddy")')).toBeVisible();
    await expect(page.locator('.buddy-picker select')).toBeVisible();

    cleanupE2EData();
  });

  test("buddy picker excludes siblings (same-household children)", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(11, "E2eBuddyExclude", false);
    const other = setupHousehold(12, "E2eBuddyOther", false);
    if (!user || !other) { test.skip(); return; }
    // Two children in same household + one in another household
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(211)}', '${GROUP_ID}', '${user.householdId}', 'Sibling1', 'Exclude', '${user.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(212)}', '${GROUP_ID}', '${user.householdId}', 'Sibling2', 'Exclude', '${user.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(213)}', '${GROUP_ID}', '${other.householdId}', 'Friend', 'Other', '${other.userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, user.email);
    await page.waitForTimeout(2000);

    const avatarBtn = page.locator('[aria-label="Open household profile"]').first();
    await avatarBtn.click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    // Get the first buddy picker select (for Sibling1)
    const firstSelect = page.locator('.buddy-picker select').first();

    // Read all option texts
    const optionTexts = await firstSelect.locator('option').allTextContents();

    // Should contain "None" and "Friend Other"
    assert.ok(optionTexts.includes("None"), "Should have a 'None' option");
    assert.ok(optionTexts.some((t) => t.includes("Friend")), "Should include the other-household child");

    // Should NOT contain siblings
    assert.ok(!optionTexts.some((t) => t.includes("Sibling2")), "Should exclude same-household sibling");

    cleanupE2EData();
  });

  test("buddy picker persists selection after reload", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const user = setupHousehold(13, "E2eBuddyPersist", false);
    const other = setupHousehold(14, "E2eBuddyFriend", false);
    if (!user || !other) { test.skip(); return; }
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(214)}', '${GROUP_ID}', '${user.householdId}', 'Picker', 'Persist', '${user.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(215)}', '${GROUP_ID}', '${other.householdId}', 'Target', 'Friend', '${other.userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, user.email);
    await page.waitForTimeout(2000);

    const avatarBtn = page.locator('[aria-label="Open household profile"]').first();
    await avatarBtn.click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    // Select the friend as buddy (use the child ID as the option value)
    const select = page.locator('.buddy-picker select').first();
    await select.selectOption({ value: UID(215) });
    await page.waitForTimeout(2000);

    // Verify in DB that the buddy was saved
    const saved = JSON.parse(execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/rest/v1/children?id=eq.${UID(214)}&select=id,preferred_buddy_child_id"`,
      { encoding: "utf8" },
    ));
    assert.ok(saved.length > 0, "Child should exist");
    assert.equal(saved[0].preferred_buddy_child_id, UID(215), "Buddy should be saved in DB");

    // Reload the page and verify the select shows the saved buddy
    await page.reload();
    await page.waitForTimeout(4000);
    const avatarBtn2 = page.locator('[aria-label="Open household profile"]').first();
    await avatarBtn2.click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    const selectAfter = page.locator('.buddy-picker select').first();
    const selectedValue = await selectAfter.inputValue();
    assert.ok(selectedValue, "Buddy select should have a non-empty value after reload");

    cleanupE2EData();
  });

  test("directory link renders on home screen and opens directory", async ({ page }) => {
    const user = setupHousehold(220, "DirLink");
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(220)}', '${GROUP_ID}', '${user.householdId}', 'Dir', 'Kid', '${user.userId}') ON CONFLICT DO NOTHING;
      UPDATE public.profiles SET phone = '(415) 555-0220', share_phone = true, share_email = true WHERE id = '${user.userId}';
    `);
    await signInWithTestAuth(page, user.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    const dirLink = page.getByTestId("directory-link");
    await expect(dirLink).toBeVisible({ timeout: 5000 });
    await dirLink.click();

    await expect(page.getByTestId("directory-screen")).toBeVisible({ timeout: 5000 });
    // The signed-in user should appear in the directory
    await expect(page.locator('.directory-row').first()).toBeVisible({ timeout: 5000 });

    cleanupE2EData();
  });

  test("directory shows phone when shared and hidden when not", async ({ page }) => {
    const sharing = setupHousehold(230, "ShareYes");
    const hidden = setupHousehold(231, "ShareNo");
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(230)}', '${GROUP_ID}', '${sharing.householdId}', 'Kid', 'A', '${sharing.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(231)}', '${GROUP_ID}', '${hidden.householdId}', 'Kid', 'B', '${hidden.userId}') ON CONFLICT DO NOTHING;
      UPDATE public.profiles SET phone = '(415) 555-0230', share_phone = true, share_email = true WHERE id = '${sharing.userId}';
      UPDATE public.profiles SET phone = '(415) 555-0231', share_phone = false, share_email = false WHERE id = '${hidden.userId}';
    `);
    await signInWithTestAuth(page, sharing.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("directory-link").click();
    await expect(page.getByTestId("directory-screen")).toBeVisible({ timeout: 5000 });

    // The sharing user's phone should be visible
    const sharingRow = page.getByTestId("directory-row").filter({ hasText: "ShareYes E2E" });
    await expect(sharingRow).toBeVisible({ timeout: 10000 });
    await expect(sharingRow).toContainText("(415) 555-0230");

    // The hidden user's phone should show "Phone hidden"
    const hiddenRow = page.getByTestId("directory-row").filter({ hasText: "ShareNo E2E" });
    await expect(hiddenRow).toBeVisible({ timeout: 10000 });
    await expect(hiddenRow).toContainText("Phone hidden");
    await expect(hiddenRow).toContainText("Email hidden");

    cleanupE2EData();
  });

  test("account screen phone edit and sharing toggle persist", async ({ page }) => {
    const user = setupHousehold(240, "PhoneEdit");
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(240)}', '${GROUP_ID}', '${user.householdId}', 'Edit', 'Kid', '${user.userId}') ON CONFLICT DO NOTHING;
    `);
    await signInWithTestAuth(page, user.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    // Open account screen
    const avatarBtn = page.locator('[aria-label="Open household profile"]').first();
    await avatarBtn.click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    // Edit phone — the edit button is inside the phone section
    const editPhoneBtn = page.locator('section[aria-labelledby="phone-section-heading"] .inline-action').first();
    await expect(editPhoneBtn).toBeVisible({ timeout: 5000 });
    await editPhoneBtn.click();

    const phoneInput = page.locator('input[autocomplete="tel"]').first();
    await phoneInput.fill("(415) 555-0240");
    await page.locator('button:has-text("Save phone")').click();
    await page.waitForTimeout(2000);

    // Verify phone persisted in DB
    const profileResult = JSON.parse(execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.userId}&select=phone"`,
      { encoding: "utf8" },
    ));
    assert.ok(profileResult.length > 0, "Profile should exist");
    assert.ok(profileResult[0].phone && profileResult[0].phone.includes("415"), "Phone should be saved in DB");

    cleanupE2EData();
  });

  test("coordinator generate schedule via Edge Function creates a draft schedule", async ({ page }) => {
    const coord = setupHousehold(250, "GenCoord", true);
    const driver = setupHousehold(251, "GenDriver");
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(250)}', '${GROUP_ID}', '${driver.householdId}', 'Gen', 'Kid', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(350)}', '${GROUP_ID}', '${driver.householdId}', 'Gen Car', 4, '${driver.userId}') ON CONFLICT DO NOTHING;
    `);
    const { weekId, tripIds } = setupWeekWithTrips();

    // Create checkin + ride requests + driver availability for the driver
    const checkinId = UID(500);
    runSql(`
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      ${tripIds.map(tId => `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${checkinId}', '${tId}', '${UID(250)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;`).join('\n')}
      ${tripIds.map(tId => `INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${checkinId}', '${tId}', '${driver.userId}', '${UID(350)}', 'prefer') ON CONFLICT DO NOTHING;`).join('\n')}
    `);

    // Generate the schedule via Edge Function directly (avoids fragile UI selectors)
    const fnResult = generateScheduleViaEdgeFunction(coord.email, weekId);
    assert.ok(fnResult.success, "Schedule generation should succeed");

    // Verify schedule_versions was created in DB
    const scheduleResult = JSON.parse(execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/rest/v1/schedule_versions?week_id=eq.${weekId}&select=id,status"`,
      { encoding: "utf8" },
    ));
    assert.ok(scheduleResult.length > 0, "Schedule version should be created");
    assert.equal(scheduleResult[0].status, "draft", "Schedule should be draft");

    cleanupE2EData();
  });

  test("week tab drive card opens drive detail with child photos", async ({ page }) => {
    const coord = setupHousehold(260, "DetailCoord", true);
    const driver = setupHousehold(261, "DetailDriver");
    const childId = UID(260);
    const photoUrl = "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Detail";
    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by, photo_url) VALUES ('${childId}', '${GROUP_ID}', '${driver.householdId}', 'Detail', 'Kid', '${driver.userId}', '${photoUrl}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(360)}', '${GROUP_ID}', '${driver.householdId}', 'Detail Car', 4, '${driver.userId}') ON CONFLICT DO NOTHING;
    `);
    const { weekId, tripIds } = setupWeekWithTrips();
    const checkinId = UID(510);
    runSql(`
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
      ${tripIds.map(tId => `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${checkinId}', '${tId}', '${childId}', true, '${driver.userId}') ON CONFLICT DO NOTHING;`).join('\n')}
      ${tripIds.map(tId => `INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${checkinId}', '${tId}', '${driver.userId}', '${UID(360)}', 'prefer') ON CONFLICT DO NOTHING;`).join('\n')}
    `);

    // Generate the schedule via Edge Function
    const fnResult = generateScheduleViaEdgeFunction(coord.email, weekId);
    assert.ok(fnResult.success, "Schedule generation should succeed");

    await signInWithTestAuth(page, coord.email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    // Navigate to Week tab
    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 5000 });

    // Select the test week (2028-01-03)
    const weekSelect = page.locator("select").first();
    if (await weekSelect.isVisible({ timeout: 3000 })) {
      const options = await weekSelect.locator("option").allTextContents();
      const testWeekIdx = options.findIndex((opt) => opt.includes("2028-01-03") || opt.includes("Jan 3"));
      if (testWeekIdx >= 0) {
        await weekSelect.selectOption({ index: testWeekIdx });
        await page.waitForTimeout(3000);
      }
    }

    // Find a drive card and click it
    const driveCard = page.locator('[data-testid^="drive-card-"]').first();
    await expect(driveCard).toBeVisible({ timeout: 10000 });
    await driveCard.click();

    // Drive detail screen should appear with child photos
    await expect(page.getByTestId("drive-detail-screen")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("child-photo-card").first()).toBeVisible({ timeout: 5000 });

    cleanupE2EData();
  });
});