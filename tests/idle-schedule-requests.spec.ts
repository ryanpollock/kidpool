// E2E regression test for the September 2026 published-schedule refetch
// loop (production egress incident, commit 28c5846): loadPublishedSchedule
// replaced publishedWeek state with a fresh object on every fetch, and the
// effect keyed on [publishedWeek] re-fired on each new object identity, so
// every open client refetched the published week, group roster, and
// published schedule forever (~9.4M queries/day observed in production).
// With the content-equality guard, an idle signed-in client issues no
// further /rest/v1/ requests after the initial load settles.

import { expect, test } from "@playwright/test";
import { getSpecEnv, makeRunSql, makeAuth, UID, PILOT_GROUP_ID, signInWithTestAuth } from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteAllTestUsers } = makeAuth(env);
const skip = !env.serviceKey;

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

function setupIdleData(): string {
  const email = "idlerider@test.kidpool";
  const userId = createTestUser(email);
  if (!userId) return "";
  const householdId = UID(570);
  const weekId = UID(578);
  const weekStart = currentMondayStrSF();
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', 'Idle Rider') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', 'Idle Household', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
    INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${weekId}', '${GROUP_ID}', '${weekStart}', 'open') ON CONFLICT DO NOTHING;
    INSERT INTO public.schedule_versions (id, group_id, week_id, version_number, status, published_at) VALUES ('${UID(579)}', '${GROUP_ID}', '${weekId}', 1, 'published', now()) ON CONFLICT DO NOTHING;
  `);
  return email;
}

function cleanupIdleData() {
  runSql(`
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id::text LIKE 'deadbeef-%';
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND entity_id::text LIKE 'deadbeef-%';
    DELETE FROM public.profiles WHERE email = 'idlerider@test.kidpool';
  `);
  deleteAllTestUsers();
}

test.describe.serial("Idle schedule refetch", () => {
  test.beforeAll(() => { cleanupIdleData(); });
  test.afterAll(() => { cleanupIdleData(); });
  test.setTimeout(120000);

  test("idle app stops refetching the published schedule", async ({ page }) => {
    test.skip(skip, "Requires service key");

    const email = setupIdleData();
    if (!email) { test.skip(); return; }

    let restRequests = 0;
    page.on("request", (req) => {
      if (req.url().includes("/rest/v1/")) restRequests++;
    });

    await signInWithTestAuth(page, email);
    await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 15000 });

    await page.waitForTimeout(4000);
    const baseline = restRequests;

    await page.waitForTimeout(8000);
    const idleRequests = restRequests - baseline;

    expect(idleRequests).toBeLessThanOrEqual(2);
  });
});