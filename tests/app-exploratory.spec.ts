// Exploratory checks — catches visual/layout issues and console errors
// that smoke tests miss. Checks element presence, dimensions, and
// console output across all tabs for a signed-in user.
//
// Run: npm run test:runtime
// Requires: npm run link:test (CLI linked to staging)

import { expect, test, type Page, type ConsoleMessage } from "@playwright/test";
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
  console.error("Aborting: tests must not run against production. Run `npm run link:test` first.");
  process.exit(1);
}

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp/project-ref"), "utf8").trim();
    if (linkedRef !== PROJECT_REF) {
      console.error(`CLI linked to ${linkedRef} but PROJECT_REF is ${PROJECT_REF}.`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref.");
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
  const tmpFile = `/tmp/kidpool-explore-query.sql`;
  execSync(`cat > "${tmpFile}" << 'ENDSQL'\n${sql}\nENDSQL`, { shell: "/bin/bash" });
  try {
    const result = execSync(`supabase db query --linked -f "${tmpFile}" 2>/dev/null`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    try { return JSON.parse(result); } catch { return {}; }
  } catch (e: unknown) {
    const stdout = (e as { stdout?: string }).stdout;
    if (stdout) { try { return JSON.parse(stdout); } catch {} }
    return {};
  }
}

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
  runSql(`DELETE FROM public.profiles WHERE email = '${email}';`);

  const body = JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: email } });
  const result = execSync(
    `curl -s -X POST -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/admin/users"`,
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(result);
  return parsed.id || null;
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
  // Use SQL to delete auth users directly
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

function cleanupData() {
  // 1. Delete test data in FK-safe order FIRST
  runSql(`
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND (
      id::text LIKE 'deadbeef-%'
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool')
    );
    UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@e2e.kidpool');
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND entity_id::text LIKE 'deadbeef-%';
    DELETE FROM public.profiles WHERE email LIKE '%@e2e.kidpool';
  `);
  // 2. Delete auth users AFTER profiles/households are gone
  deleteTestUsersByEmail();
}

async function signInWithTestAuth(page: Page, email: string) {
  await page.goto(`/?testAuth=${email}|${TEST_PASSWORD}`);
  await expect(
    page.getByTestId("home-screen").or(page.getByTestId("onboarding-screen"))
  ).toBeVisible({ timeout: 15000 });
}

test.describe("Exploratory Checks", () => {
  test.beforeAll(() => {
    cleanupData();
  });

  test.afterAll(() => {
    cleanupData();
  });

  test.afterEach(() => {
    cleanupData();
  });

  test("brand header + profile button present on every tab", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const userId = createTestUser("explore@e2e.kidpool");
    if (!userId) { test.skip(); return; }
    const householdId = UID(160);
    runSql(`
      INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', 'explore@e2e.kidpool', 'Explore Test') ON CONFLICT DO NOTHING;
      INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', 'Explore Test', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(260)}', '${GROUP_ID}', '${householdId}', 'Kid', 'Explore', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(360)}', '${GROUP_ID}', '${householdId}', 'Car', 4, true, '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${UID(960)}', '${GROUP_ID}', '2028-01-03', 'open') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, "explore@e2e.kidpool");
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    // Check nav tabs (home, plan, week, coordinate)
    const tabs = ["home", "plan", "week", "coordinate"];
    for (const tab of tabs) {
      await page.getByTestId(`nav-${tab}`).click();
      await page.waitForTimeout(1000);

      const brandLockup = page.locator(".brand-lockup");
      await expect(brandLockup).toBeVisible({ timeout: 5000 });
      await expect(brandLockup.locator("text=Midtown Carpool")).toBeVisible();

      const avatarButton = page.locator(".avatar-button");
      await expect(avatarButton).toBeVisible({ timeout: 3000 });
    }

    // Check account screen (opened via avatar button, not a nav tab)
    await page.locator(".avatar-button").click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".brand-lockup")).not.toBeVisible(0);
  });

  test("no console errors on any tab", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const errors: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!text.includes("favicon") && !text.includes("service worker")) {
          errors.push(text);
        }
      }
    });

    const userId = createTestUser("exploreconsole@e2e.kidpool");
    if (!userId) { test.skip(); return; }
    const householdId = UID(161);
    runSql(`
      INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', 'exploreconsole@e2e.kidpool', 'Console Test') ON CONFLICT DO NOTHING;
      INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', 'Console Test', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(261)}', '${GROUP_ID}', '${householdId}', 'Kid', 'Console', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(361)}', '${GROUP_ID}', '${householdId}', 'Car', 4, true, '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${UID(961)}', '${GROUP_ID}', '2028-01-03', 'open') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, "exploreconsole@e2e.kidpool");
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    // Visit each nav tab
    for (const tab of ["plan", "week", "coordinate", "home"]) {
      await page.getByTestId(`nav-${tab}`).click();
      await page.waitForTimeout(1500);
    }

    // Visit account screen via avatar button
    await page.locator(".avatar-button").click();
    await page.waitForTimeout(1500);

    expect(errors, `Console errors found: ${errors.join("; ")}`).toEqual([]);
  });

  test("week tab morning and afternoon legs have similar widths", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const userId = createTestUser("explorelayout@e2e.kidpool");
    if (!userId) { test.skip(); return; }
    const householdId = UID(162);
    const weekId = UID(962);
    runSql(`
      INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', 'explorelayout@e2e.kidpool', 'Layout Test') ON CONFLICT DO NOTHING;
      INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', 'Layout Test', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(262)}', '${GROUP_ID}', '${householdId}', 'Kid', 'Layout', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(362)}', '${GROUP_ID}', '${householdId}', 'Car', 4, true, '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${weekId}', '${GROUP_ID}', '2028-01-03', 'open') ON CONFLICT DO NOTHING;
      INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES
        ('${UID(462)}', '${GROUP_ID}', '${weekId}', '2028-01-03', 'morning', '08:40', '08:45', 'Midtown', 'Presidio'),
        ('${UID(463)}', '${GROUP_ID}', '${weekId}', '2028-01-03', 'afternoon', '15:15', '15:20', 'Presidio', 'Midtown') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, "explorelayout@e2e.kidpool");
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("nav-week").click();
    await expect(page.getByTestId("week-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const legs = page.locator(".leg");
    const legCount = await legs.count();
    if (legCount >= 2) {
      const firstWidth = await legs.nth(0).boundingBox();
      const secondWidth = await legs.nth(1).boundingBox();
      expect(firstWidth, "First leg should have a width").not.toBeNull();
      expect(secondWidth, "Second leg should have a width").not.toBeNull();
      if (firstWidth && secondWidth) {
        const diff = Math.abs(firstWidth.width - secondWidth.width);
        expect(diff, `Morning leg width (${firstWidth.width}px) and afternoon leg width (${secondWidth.width}px) differ by ${diff}px`).toBeLessThan(10);
      }
    }
  });

  test("buddy picker renders on account screen with correct label", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const userId = createTestUser("explorebuddy@e2e.kidpool");
    if (!userId) { test.skip(); return; }
    const householdId = UID(163);
    runSql(`
      INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', 'explorebuddy@e2e.kidpool', 'Buddy Explore') ON CONFLICT DO NOTHING;
      INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', 'Buddy Explore', '${userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(263)}', '${GROUP_ID}', '${householdId}', 'Buddy', 'Kid', '${userId}') ON CONFLICT DO NOTHING;
    `);

    await signInWithTestAuth(page, "explorebuddy@e2e.kidpool");
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 10000 });

    // Navigate to account screen
    await page.locator(".avatar-button").click();
    await expect(page.getByTestId("account-screen")).toBeVisible({ timeout: 5000 });

    // Verify buddy picker is visible with correct label
    await expect(page.locator('.buddy-picker > span:has-text("Riding buddy")')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.buddy-picker select')).toBeVisible();

    // Verify the select has a "None" option as default
    const select = page.locator('.buddy-picker select').first();
    const selectedValue = await select.inputValue();
    expect(selectedValue).toBe("");
  });
});