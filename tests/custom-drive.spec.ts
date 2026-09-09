// E2E tests for ad hoc custom drives (slot='custom', arbitrary meeting_time).
// Covers the full lifecycle through the real UI: a driver offers an extra
// drive from Home, a rider adds their child from the drive detail screen,
// and the driver cancels it. Backed by the custom-drive RPCs.
//
// Run locally:   npm run test:runtime:local -- --grep "Custom drive"
// Run on staging: npm run test:runtime -- --grep "Custom drive"

import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID, signInWithTestAuth,
} from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteTestUsersByDomain } = makeAuth(env);
const skip = !env.serviceKey;

const GROUP_ID = PILOT_GROUP_ID;
// Unique email domain + deadbeef ID range for this spec. The staging suite
// runs spec files in parallel — a cleanup that wipes all @test.kidpool /
// deadbeef rows mid-suite deletes OTHER specs' in-flight users and trips,
// cascading sign-in failures across the whole run. Everything this spec
// creates lives under @custom.kidpool and UID(53x-55x), and cleanup only
// ever touches those.
const EMAIL_DOMAIN = "@custom.kidpool";

function sfDateStr(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function thisMondayStrSF(): string {
  const today = sfDateStr(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayChipLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

interface Household {
  userId: string;
  householdId: string;
  email: string;
}

function setupHousehold(n: number, name: string): Household | null {
  const email = `custom-${name.toLowerCase()}${EMAIL_DOMAIN}`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(530 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Custom') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Custom', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function cleanupCustomDriveData(): void {
  if (env.isLocal) {
    truncateAll(runSql, GROUP_ID);
  } else {
    // Scoped to this spec's own rows only (see EMAIL_DOMAIN note above).
    runSql(`
      DELETE FROM public.trips WHERE group_id = '${GROUP_ID}' AND slot = 'custom' AND meeting_time = '16:50';
      DELETE FROM public.schedule_versions WHERE id = '${UID(551)}';
      DELETE FROM public.weeks WHERE id = '${UID(550)}' AND group_id = '${GROUP_ID}';
      DELETE FROM public.children WHERE id IN ('${UID(540)}', '${UID(541)}');
      DELETE FROM public.vehicles WHERE id = '${UID(545)}';
      DELETE FROM public.memberships WHERE household_id IN ('${UID(530)}', '${UID(531)}');
      DELETE FROM public.households WHERE id IN ('${UID(530)}', '${UID(531)}');
      DELETE FROM public.profiles WHERE email LIKE '%${EMAIL_DOMAIN}';
      DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND entity_id::text LIKE 'deadbeef-%';
    `);
  }
  deleteTestUsersByDomain(EMAIL_DOMAIN);
}

// Poll SQL until the predicate passes or the deadline elapses.
async function pollSql(sql: string, predicate: (rows: Array<Record<string, unknown>>) => boolean, ms = 10000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = runSql(sql).rows ?? [];
    if (predicate(rows)) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// ── Module-level state ────────────────────────────────────────────

let driverEmail = "";
let riderEmail = "";
let driverChildId = "";
let riderChildId = "";
let serviceDate = "";
let setupReady = false;
let customTripId = "";

test.describe.serial("Custom drive", () => {
  test.beforeAll(() => {
    cleanupCustomDriveData();

    const driver = setupHousehold(0, "Casey");
    const rider = setupHousehold(1, "Riley");
    if (!driver || !rider) return;
    driverEmail = driver.email;
    riderEmail = rider.email;
    driverChildId = UID(540);
    riderChildId = UID(541);

    runSql(`
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${driverChildId}', '${GROUP_ID}', '${driver.householdId}', 'Dana', 'Custom', '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(545)}', '${GROUP_ID}', '${driver.householdId}', 'Honda', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${riderChildId}', '${GROUP_ID}', '${rider.householdId}', 'Sam', 'Custom', '${rider.userId}') ON CONFLICT DO NOTHING;
    `);

    // The current week must exist with a published schedule version —
    // custom drives attach to it.
    const monday = thisMondayStrSF();
    runSql(`INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${UID(550)}', '${GROUP_ID}', '${monday}', 'open') ON CONFLICT DO NOTHING;`);
    const weekRow = runSql(`SELECT id FROM public.weeks WHERE group_id = '${GROUP_ID}' AND starts_on = '${monday}' LIMIT 1;`).rows?.[0] as { id: string } | undefined;
    if (!weekRow) return;
    const published = runSql(`SELECT id FROM public.schedule_versions WHERE group_id = '${GROUP_ID}' AND week_id = '${weekRow.id}' AND status = 'published' LIMIT 1;`).rows?.[0] as { id: string } | undefined;
    if (!published) {
      runSql(`INSERT INTO public.schedule_versions (id, group_id, week_id, version_number, status, published_at) VALUES ('${UID(551)}', '${GROUP_ID}', '${weekRow.id}', 1, 'published', now()) ON CONFLICT DO NOTHING;`);
    }

    // First remaining weekday of the published week that still has pickup
    // time left (a same-day 4:50 PM offer needs to be before ~4 PM).
    const today = sfDateStr(new Date());
    const sfHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date());
    let candidate = monday < today ? today : monday;
    for (let i = 0; i < 5; i++) {
      const d = addDays(monday, i);
      if (d < candidate) continue;
      if (d === today && parseInt(sfHour, 10) >= 16) continue;
      candidate = d;
      break;
    }
    if (candidate < today) return; // weekend / late Friday — nothing offerable
    serviceDate = candidate;
    setupReady = true;
  });

  test.afterAll(() => {
    cleanupCustomDriveData();
  });

  test("driver offers a 4:50 PM extra drive from Home", async ({ page }) => {
    test.skip(skip || !setupReady, "needs service key + an offerable weekday");
    await signInWithTestAuth(page, driverEmail);

    const offerButton = page.getByTestId("offer-custom-drive");
    await expect(offerButton).toBeVisible({ timeout: 20000 });
    await offerButton.click();

    await page.getByTestId("offer-time-input").fill("16:50");
    await page.locator(".offer-chip", { hasText: new RegExp(`^${weekdayChipLabel(serviceDate)}$`) }).click();
    await page.locator(".offer-chip", { hasText: "Afternoon" }).first().click();
    await page.locator(".offer-chip", { hasText: "Dana" }).click();
    await page.getByTestId("offer-submit").click();

    const trips = await pollSql(
      `SELECT id, slot, meeting_time FROM public.trips WHERE group_id = '${GROUP_ID}' AND slot = 'custom' AND service_date = '${serviceDate}';`,
      (rows) => rows.length > 0,
    );
    assert.equal(trips.length, 1, `custom trip should exist after offering: ${JSON.stringify(trips)}`);
    customTripId = String(trips[0].id);
    assert.ok(String(trips[0].meeting_time).startsWith("16:50"));

    // The offered drive renders on Home with the Extra drive distinction
    await expect(page.getByText("4:50 PM").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Extra drive").first()).toBeVisible({ timeout: 5000 });

    // Confirmed driver assignment + own child as rider on the published version
    const assignments = runSql(`
      SELECT da.id, da.status, da.driver_profile_id
      FROM public.driver_assignments da
      JOIN public.schedule_versions sv ON sv.id = da.schedule_version_id
      WHERE da.trip_id = '${customTripId}' AND sv.status = 'published';
    `).rows ?? [];
    assert.equal(assignments.length, 1, "one published-version assignment");
    assert.equal(assignments[0].status, "confirmed");
    const riders = runSql(`SELECT child_id FROM public.rider_assignments WHERE trip_id = '${customTripId}';`).rows ?? [];
    assert.ok(riders.some((r) => String(r.child_id) === driverChildId), "own child rides the offered drive");
  });

  test("rider joins from the drive detail screen", async ({ page }) => {
    test.skip(skip || !setupReady || !customTripId, "needs prior offer test");
    await signInWithTestAuth(page, riderEmail);

    await page.getByTestId("nav-week").click();
    await expect(page.getByText("4:50 PM").first()).toBeVisible({ timeout: 15000 });
    // The auth-trigger profile uses the email as the display name until the
    // user edits it — match the roster button on the driver's email.
    await page.locator(".trip-roster", { hasText: driverEmail }).first().click();

    const joinBlock = page.getByTestId("custom-join-block");
    await expect(joinBlock).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`custom-join-${riderChildId}`).click();

    const riders = await pollSql(
      `SELECT child_id FROM public.rider_assignments WHERE trip_id = '${customTripId}';`,
      (rows) => rows.some((r) => String(r.child_id) === riderChildId),
    );
    assert.ok(riders.some((r) => String(r.child_id) === riderChildId), "joined child now rides the custom drive");

    // The drive detail roster reflects the join
    await expect(page.getByText("Sam Custom").first()).toBeVisible({ timeout: 10000 });
  });

  test("driver cancels the extra drive from the drive detail screen", async ({ page }) => {
    test.skip(skip || !setupReady || !customTripId, "needs prior offer test");
    await signInWithTestAuth(page, driverEmail);

    await page.getByTestId("nav-week").click();
    await expect(page.getByText("4:50 PM").first()).toBeVisible({ timeout: 15000 });
    await page.locator(".trip-roster", { hasText: driverEmail }).first().click();

    await page.getByTestId("cancel-custom-drive").click();
    await page.getByTestId("confirm-cancel-custom-drive").click();

    const trips = await pollSql(
      `SELECT id FROM public.trips WHERE id = '${customTripId}';`,
      (rows) => rows.length === 0,
    );
    assert.equal(trips.length, 0, "custom drive is deleted on cancel");
  });
});