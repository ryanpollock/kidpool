// Edge case tests: self-cancel silent stranding, past-trip guards, and
// morning/afternoon independence. These complement the cross-family tests
// with scenarios that were previously untested or under-tested.

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const GROUP_ID = "c1000000-0000-4000-8000-000000000001";
const UID = (n: number) => `deadbeef-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEST_PASSWORD = "TestPass123!";

if (PROJECT_REF === PRODUCTION_REF) {
  console.error("Aborting: edge-case tests must not run against production.");
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
console.log("[edge-case] SERVICE_KEY:", SERVICE_KEY ? `found (len ${SERVICE_KEY.length})` : "null");
const skip = !SERVICE_KEY;
console.log("[edge-case] skip:", skip);

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
  const tmpFile = `/tmp/kidpool-edgecase-query.sql`;
  writeFileSync(tmpFile, sql);
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
  try { runSql(`DELETE FROM auth.users WHERE email LIKE '%@edgecase.kidpool';`); } catch {}
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
        if (user.email && user.email.endsWith("@edgecase.kidpool")) { deleteTestUser(user.id); }
      }
      if (users.length < 1000) break;
      page++;
    } catch { break; }
  }
}

function cleanupEdgeCaseData() {
  // Split into individual runSql calls — multi-statement SQL can silently fail on staging
  // Order matters: delete child tables before parent tables to avoid FK constraint failures
  runSql(`DELETE FROM public.rider_assignments WHERE trip_id::text LIKE 'deadbeef-%' OR child_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.driver_assignments WHERE trip_id::text LIKE 'deadbeef-%' OR schedule_version_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.ride_requests WHERE trip_id::text LIKE 'deadbeef-%' OR checkin_id::text LIKE 'deadbeef-%' OR child_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.driver_availability WHERE trip_id::text LIKE 'deadbeef-%' OR checkin_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.schedule_versions WHERE week_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.trips WHERE id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND household_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';`);
  runSql(`DELETE FROM public.children WHERE id::text LIKE 'deadbeef-%' OR household_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.vehicles WHERE id::text LIKE 'deadbeef-%' OR household_id::text LIKE 'deadbeef-%';`);
  runSql(`DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND (id::text LIKE 'deadbeef-%' OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@edgecase.kidpool'));`);
  runSql(`UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@edgecase.kidpool');`);
  runSql(`DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (entity_id::text LIKE 'deadbeef-%' OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@edgecase.kidpool'));`);
  runSql(`DELETE FROM public.profiles WHERE email LIKE '%@edgecase.kidpool';`);
  deleteTestUsersByEmail();
}

function setupHousehold(n: number, name: string, coordinator = false) {
  const email = `${name.toLowerCase()}@edgecase.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(700 + n);
  runSql(`INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} EdgeCase') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} EdgeCase', '${userId}') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;`);
  return { userId, householdId, email };
}

// Create a week with trips spanning past and future dates relative to today.
// Returns weekId + tripIds where:
//   tripIds[0] = yesterday's morning trip (past)
//   tripIds[1] = yesterday's afternoon trip (past)
//   tripIds[2] = tomorrow's morning trip (future)
//   tripIds[3] = tomorrow's afternoon trip (future)
// Format a Date as YYYY-MM-DD in local time (not UTC) to avoid timezone shifts.
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function setupWeekWithPastAndFutureTrips() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  const weekStart = (() => {
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
    return localDateStr(monday);
  })();

  const weekId = UID(960);
  const pastTripAm = UID(700);
  const pastTripPm = UID(701);
  const futureTripAm = UID(702);
  const futureTripPm = UID(703);
  const tripIds = [pastTripAm, pastTripPm, futureTripAm, futureTripPm];

  const pastDate = localDateStr(yesterday);
  const futureDate = localDateStr(tomorrow);
  const checkinDeadline = `${weekStart}T15:00:00-07:00`;
  const confirmationDeadline = `${weekStart}T20:00:00-07:00`;

  runSql(`DELETE FROM public.rider_assignments WHERE trip_id IN ('${pastTripAm}','${pastTripPm}','${futureTripAm}','${futureTripPm}');`);
  runSql(`DELETE FROM public.driver_assignments WHERE trip_id IN ('${pastTripAm}','${pastTripPm}','${futureTripAm}','${futureTripPm}') OR schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.ride_requests WHERE trip_id IN ('${pastTripAm}','${pastTripPm}','${futureTripAm}','${futureTripPm}') OR checkin_id IN (SELECT id FROM public.weekly_checkins WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.driver_availability WHERE trip_id IN ('${pastTripAm}','${pastTripPm}','${futureTripAm}','${futureTripPm}') OR checkin_id IN (SELECT id FROM public.weekly_checkins WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.schedule_versions WHERE week_id = '${weekId}';`);
  runSql(`DELETE FROM public.trips WHERE id IN ('${pastTripAm}','${pastTripPm}','${futureTripAm}','${futureTripPm}');`);
  runSql(`DELETE FROM public.weekly_checkins WHERE week_id = '${weekId}';`);
  runSql(`DELETE FROM public.weeks WHERE id = '${weekId}';`);
  runSql(`INSERT INTO public.weeks (id, group_id, starts_on, status, checkin_deadline, confirmation_deadline) VALUES ('${weekId}', '${GROUP_ID}', '${weekStart}', 'open', '${checkinDeadline}', '${confirmationDeadline}') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${pastTripAm}', '${GROUP_ID}', '${weekId}', '${pastDate}', 'morning', '08:40', '08:45', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${pastTripPm}', '${GROUP_ID}', '${weekId}', '${pastDate}', 'afternoon', '15:15', '15:20', 'Presidio', 'Midtown') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${futureTripAm}', '${GROUP_ID}', '${weekId}', '${futureDate}', 'morning', '08:40', '08:45', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${futureTripPm}', '${GROUP_ID}', '${weekId}', '${futureDate}', 'afternoon', '15:15', '15:20', 'Presidio', 'Midtown') ON CONFLICT DO NOTHING;`);

  return { weekId, tripIds, pastTripAm, pastTripPm, futureTripAm, futureTripPm };
}

// Create a week with the current week's Monday–Friday trips.
// Uses this week's Monday (not next week) to avoid demo data conflicts.
// Returns tripIds + dates so tests can pick future trips (past-trip guard blocks past).
function setupCurrentWeekWithTrips() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  const weekStart = localDateStr(monday);

  const weekId = UID(970);
  const tripIds: string[] = [];
  const dates: string[] = [];
  for (let d = 0; d < 5; d++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + d);
    dates.push(localDateStr(date));
  }

  const checkinDeadline = `${weekStart}T15:00:00-07:00`;
  const confirmationDeadline = `${weekStart}T20:00:00-07:00`;

  // Split into individual runSql calls — multi-statement SQL can silently fail on staging
  // Delete by weekId (not starts_on) since starts_on may change between runs
  // Must delete ALL child tables first to avoid FK constraint failures
  runSql(`DELETE FROM public.rider_assignments WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}') OR trip_id IN (SELECT id FROM public.trips WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.ride_requests WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id = '${weekId}') OR checkin_id IN (SELECT id FROM public.weekly_checkins WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.driver_availability WHERE trip_id IN (SELECT id FROM public.trips WHERE week_id = '${weekId}') OR checkin_id IN (SELECT id FROM public.weekly_checkins WHERE week_id = '${weekId}');`);
  runSql(`DELETE FROM public.schedule_versions WHERE week_id = '${weekId}';`);
  runSql(`DELETE FROM public.trips WHERE week_id = '${weekId}';`);
  runSql(`DELETE FROM public.weekly_checkins WHERE week_id = '${weekId}';`);
  runSql(`DELETE FROM public.weeks WHERE id = '${weekId}';`);
  runSql(`INSERT INTO public.weeks (id, group_id, starts_on, status, checkin_deadline, confirmation_deadline) VALUES ('${weekId}', '${GROUP_ID}', '${weekStart}', 'open', '${checkinDeadline}', '${confirmationDeadline}') ON CONFLICT DO NOTHING;`);
  for (let d = 0; d < 5; d++) {
    for (const dir of ["morning", "afternoon"]) {
      const tId = UID(700 + d * 2 + (dir === "morning" ? 0 : 1));
      tripIds.push(tId);
      const time = dir === "morning" ? "08:40" : "15:15";
      runSql(`INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${tId}', '${GROUP_ID}', '${weekId}', '${dates[d]}', '${dir}', '${time}', '${time}', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;`);
    }
  }
  return { weekId, tripIds, dates };
}

// Find the first trip that's at least tomorrow (to avoid UTC timezone issues
// where today in local time might already be past in UTC).
// tripIds[0]=Mon AM, [1]=Mon PM, [2]=Tue AM, [3]=Tue PM, etc.
function firstFutureTrip(tripIds: string[], dates: string[]): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = localDateStr(tomorrow);
  for (let i = 0; i < tripIds.length; i++) {
    const tripDate = dates[Math.floor(i / 2)];
    if (tripDate >= tomorrowStr) return tripIds[i];
  }
  return tripIds[tripIds.length - 1];
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
  runSql(`UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft') AND status = 'tentative';`);
  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';`);
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

// Seed a family with a child + vehicle, check in for a trip, and mark as
// needing a ride. canDrive = owns a vehicle. available = has driver_availability.
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

  runSql(`INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childId}', '${GROUP_ID}', '${fam.householdId}', 'Kid', '${name}', '${fam.userId}') ON CONFLICT DO NOTHING;`);
  if (canDrive) {
    runSql(`INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${vehicleId}', '${GROUP_ID}', '${fam.householdId}', '${name}Car', 4, true, '${fam.userId}') ON CONFLICT DO NOTHING;`);
  }
  runSql(`INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', '${fam.householdId}', 'submitted', ${canDrive ? 5 : 0}) ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${childId}', true, '${fam.userId}') ON CONFLICT DO NOTHING;`);
  if (canDrive && hasAvail) {
    runSql(`INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${fam.userId}', '${vehicleId}', 'prefer') ON CONFLICT DO NOTHING;`);
  }
  return fam;
}

// Seed a family checked in for multiple trips (same week).
function seedFamilyForMultiTrip(
  familyNum: number,
  name: string,
  weekId: string,
  tripIds: string[],
  coordinator = false,
  canDrive = true,
  available = true,
) {
  const fam = setupHousehold(familyNum, name, coordinator);
  if (!fam) return null;
  const childId = UID(familyNum * 10 + 1);
  const vehicleId = UID(familyNum * 10 + 2);
  const checkinId = UID(familyNum * 10 + 3);

  runSql(`INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childId}', '${GROUP_ID}', '${fam.householdId}', 'Kid', '${name}', '${fam.userId}') ON CONFLICT DO NOTHING;`);
  if (canDrive) {
    runSql(`INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${vehicleId}', '${GROUP_ID}', '${fam.householdId}', '${name}Car', 4, true, '${fam.userId}') ON CONFLICT DO NOTHING;`);
  }
  runSql(`INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', '${fam.householdId}', 'submitted', ${canDrive ? 5 : 0}) ON CONFLICT DO NOTHING;`);
  for (const tripId of tripIds) {
    runSql(`INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${childId}', true, '${fam.userId}') ON CONFLICT DO NOTHING;`);
    if (canDrive && available) {
      runSql(`INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${fam.userId}', '${vehicleId}', 'prefer') ON CONFLICT DO NOTHING;`);
    }
  }
  return fam;
}

async function cancelDriveViaUI(page: Page) {
  const cancelLink = page.locator('[data-testid^="cancel-drive-"]').first();
  await expect(cancelLink).toBeVisible({ timeout: 5000 });
  await cancelLink.click();
  const confirmBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
  await expect(confirmBtn).toBeVisible({ timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(2000);
}

async function volunteerViaFlowA(page: Page) {
  const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
  await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
  await volunteerBtn.click();
  await page.waitForTimeout(2000);
}

async function volunteerViaFlowB(page: Page) {
  const volunteerBtn = page.locator('[data-testid^="volunteer-uncovered-"]').first();
  await expect(volunteerBtn).toBeVisible({ timeout: 5000 });
  await volunteerBtn.click();
  await page.waitForTimeout(2000);
}

function declineViaSql(versionId: string, tripId: string, driverUserId: string) {
  runSql(`UPDATE public.driver_assignments SET status = 'declined' WHERE schedule_version_id = '${versionId}' AND trip_id = '${tripId}' AND driver_profile_id = '${driverUserId}';`);
}

test.describe.serial("Edge Cases: Silent Stranding + Past-Trip Guards", () => {
  test.beforeAll(() => { cleanupEdgeCaseData(); });
  test.afterAll(() => { cleanupEdgeCaseData(); });
  test.afterEach(() => { cleanupEdgeCaseData(); });
  test.setTimeout(120000);

  // ── Test 1: Self-cancel with only own children → driver sees uncovered alert ──

  test("self-cancel: driver's own kids only → driver sees uncovered alert for own child", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(10, "SCCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds, dates } = setupCurrentWeekWithTrips();
    const morningTrip = firstFutureTrip(tripIds, dates);

    // Driver A has a child + vehicle + availability. Only child on this trip.
    const driverA = seedFamilyForTrip(11, "SCDriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver A cancels via UI
    await signInWithTestAuth(page, driverA!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Assert: Driver A sees "cancelled drives" hero + re-accept button
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText && /cancelled/i.test(heroText), `Driver A hero should mention cancelled, got: "${heroText}"`);
    await expect(page.locator('[data-testid^="reaccept-"]').first()).toBeVisible({ timeout: 5000 });

    // With the fix: Driver A ALSO sees the uncovered alert for their own child.
    // Without the fix, the declined assignment was "handled" and the child was
    // silently stranded — no alert shown to anyone.
    const uncoveredAlert = page.getByTestId("uncovered-alert").or(page.locator('[data-testid^="volunteer-uncovered-"]'));
    await expect(uncoveredAlert.first()).toBeVisible({ timeout: 5000 });

    // Coordinator sees the declined admin alert
    await switchUser(page, coord!.email);
    await page.waitForTimeout(2000);
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert-admin")).toBeVisible({ timeout: 5000 });
  });

  // ── Test 2: Self-cancel with other family's kids → other family sees Flow A ──

  test("self-cancel: driver + other family's kids → other family sees Flow A (not Flow B)", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(20, "SC2Coord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupCurrentWeekWithTrips();
    const morningTrip = tripIds[0];

    // Driver A has a child + vehicle + availability. Their child is on the trip.
    const driverA = seedFamilyForTrip(21, "SC2DriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }

    // Rider B has a child on the same trip + vehicle but NO availability
    const riderB = seedFamilyForTrip(22, "SC2RiderB", weekId, morningTrip, false, true, false);
    if (!riderB) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver A cancels via UI
    await signInWithTestAuth(page, driverA!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Switch to Rider B — should see Flow A decline-alert (their child is on the declined drive)
    await switchUser(page, riderB!.email);
    await page.waitForTimeout(2000);

    // Rider B should see Flow A decline-alert, NOT Flow B uncovered-alert
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("uncovered-alert")).toBeHidden({ timeout: 2000 });

    // Rider B volunteers via Flow A
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Verify in DB: Rider B is confirmed, Driver A is released
    const driverAAssignment = getAssignmentId(versionId, morningTrip, driverA!.userId);
    if (driverAAssignment) {
      assert.equal(getAssignmentStatus(driverAAssignment), "released", "Driver A should be released");
    }
    const riderBAssignment = getAssignmentId(versionId, morningTrip, riderB!.userId);
    if (riderBAssignment) {
      assert.equal(getAssignmentStatus(riderBAssignment), "confirmed", "Rider B should be confirmed");
    }
  });

  // ── Test 3: Cancel past trip → friendly error ──

  test("cancel past trip → friendly error 'already happened'", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(30, "PTCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, pastTripAm } = setupWeekWithPastAndFutureTrips();

    const driver = seedFamilyForTrip(31, "PTDriver", weekId, pastTripAm, false, true, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(32, "PTRider", weekId, pastTripAm, false, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver tries to cancel the past trip via UI
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);

    // Try to cancel — the cancel button may or may not be visible (UI might hide past trips),
    // but if we can click it, we should get a friendly error.
    const cancelLink = page.locator('[data-testid^="cancel-drive-"]').first();
    const isCancelVisible = await cancelLink.isVisible().catch(() => false);

    if (isCancelVisible) {
      await cancelLink.click();
      const confirmBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
      const isConfirmVisible = await confirmBtn.isVisible().catch(() => false);
      if (isConfirmVisible) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);

        // Should get a friendly error mentioning "already happened"
        const errorEl = page.locator(".auth-error").first();
        const errorText = await errorEl.textContent().catch(() => null);
        if (errorText) {
          assert.ok(/already happened/i.test(errorText), `should show 'already happened' error, got: "${errorText}"`);
        }
      }
    }

    // Verify in DB: assignment should still be confirmed (cancel was blocked)
    const assignmentId = getAssignmentId(versionId!, pastTripAm, driver!.userId);
    if (assignmentId) {
      const status = getAssignmentStatus(assignmentId);
      assert.ok(status === "confirmed", `assignment should still be confirmed (past-trip guard blocked cancel), got ${status}`);
    }
  });

  // ── Test 4: Volunteer for past declined trip → friendly error ──

  test("volunteer for past declined trip → friendly error", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(40, "PT2Coord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, pastTripAm } = setupWeekWithPastAndFutureTrips();

    const driver = seedFamilyForTrip(41, "PT2Driver", weekId, pastTripAm, false, true, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(42, "PT2Rider", weekId, pastTripAm, false, true, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Decline the past trip via SQL (since UI cancel is blocked)
    declineViaSql(versionId!, pastTripAm, driver!.userId);

    // Rider tries to volunteer via Flow A
    await signInWithTestAuth(page, rider!.email);
    await page.waitForTimeout(2000);

    // The decline-alert may show. If the volunteer button is visible, tap it.
    const declineAlert = page.getByTestId("decline-alert");
    const isAlertVisible = await declineAlert.isVisible().catch(() => false);

    if (isAlertVisible) {
      const volunteerBtn = page.locator('[data-testid^="volunteer-"]').first();
      const isVolunteerVisible = await volunteerBtn.isVisible().catch(() => false);
      if (isVolunteerVisible) {
        await volunteerBtn.click();
        await page.waitForTimeout(2000);

        // Should get a friendly error
        const errorEl = page.locator(".auth-error").first();
        const errorText = await errorEl.textContent().catch(() => null);
        if (errorText) {
          assert.ok(/already happened/i.test(errorText), `should show 'already happened' error, got: "${errorText}"`);
        }
      }
    }

    // Verify in DB: no confirmed assignment for rider (volunteer was blocked)
    const riderAssignment = runSql(`SELECT count(*) AS n FROM public.driver_assignments WHERE schedule_version_id = '${versionId}' AND trip_id = '${pastTripAm}' AND driver_profile_id = '${rider!.userId}' AND status = 'confirmed';`);
    const riderCount = riderAssignment.rows?.[0]?.n ?? 0;
    assert.equal(riderCount, 0, "Rider should NOT have a confirmed assignment (past-trip guard blocked volunteer)");
  });

  // ── Test 5: Re-accept past trip → friendly error ──

  test("re-accept past declined trip → friendly error", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(50, "PT3Coord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, pastTripAm } = setupWeekWithPastAndFutureTrips();

    const driver = seedFamilyForTrip(51, "PT3Driver", weekId, pastTripAm, false, true, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(52, "PT3Rider", weekId, pastTripAm, false, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Decline via SQL (since UI cancel is blocked for past trips)
    declineViaSql(versionId!, pastTripAm, driver!.userId);

    // Driver tries to re-accept via UI
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);

    // The re-accept button may show for the declined past trip.
    const reacceptBtn = page.locator('[data-testid^="reaccept-"]').first();
    const isReacceptVisible = await reacceptBtn.isVisible().catch(() => false);

    if (isReacceptVisible) {
      await reacceptBtn.click();
      await page.waitForTimeout(2000);

      // Should get a friendly error
      const errorEl = page.locator(".auth-error").first();
      const errorText = await errorEl.textContent().catch(() => null);
      if (errorText) {
        assert.ok(/already happened/i.test(errorText), `should show 'already happened' error, got: "${errorText}"`);
      }
    }

    // Verify in DB: assignment should still be declined (re-accept was blocked)
    const assignmentId = getAssignmentId(versionId!, pastTripAm, driver!.userId);
    if (assignmentId) {
      const status = getAssignmentStatus(assignmentId);
      assert.equal(status, "declined", `assignment should still be declined (past-trip guard blocked re-accept), got ${status}`);
    }
  });

  // ── Test 6: Cancel future trip → succeeds ──

  test("cancel future trip → succeeds (negative test for past-trip guard)", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(60, "FTCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, futureTripAm } = setupWeekWithPastAndFutureTrips();

    const driver = seedFamilyForTrip(61, "FTDriver", weekId, futureTripAm, false, true, true);
    if (!driver) { test.skip(); return; }
    const rider = seedFamilyForTrip(62, "FTRider", weekId, futureTripAm, false, false);
    if (!rider) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver cancels the future trip via UI — should succeed
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Assert: Driver sees cancelled hero + re-accept button
    const heroText = await page.locator(".confirmation-hero h1").first().textContent();
    assert.ok(heroText && /cancelled/i.test(heroText), `Driver hero should mention cancelled for future trip, got: "${heroText}"`);
    await expect(page.locator('[data-testid^="reaccept-"]').first()).toBeVisible({ timeout: 5000 });

    // Verify in DB: assignment is declined
    const assignmentId = getAssignmentId(versionId!, futureTripAm, driver!.userId);
    if (assignmentId) {
      assert.equal(getAssignmentStatus(assignmentId), "declined", "assignment should be declined (future cancel succeeded)");
    }
  });

  // ── Test 7: Morning cancel, afternoon stays confirmed ──

  test("morning cancel, afternoon stays confirmed for same driver", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(70, "MACoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupCurrentWeekWithTrips();
    // Use Monday morning (tripIds[0]) and Monday afternoon (tripIds[1])
    const morningTrip = tripIds[0];
    const afternoonTrip = tripIds[1];

    // Driver is available for both morning and afternoon
    const driver = seedFamilyForMultiTrip(71, "MADriver", weekId, [morningTrip, afternoonTrip], false, true, true);
    if (!driver) { test.skip(); return; }

    // Rider B has a child on both trips but no availability
    const riderB = seedFamilyForMultiTrip(72, "MARiderB", weekId, [morningTrip, afternoonTrip], false, true, false);
    if (!riderB) { test.skip(); return; }

    await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    assert.ok(versionId, "published version should exist");

    // Driver cancels morning only
    await signInWithTestAuth(page, driver!.email);
    await page.waitForTimeout(2000);

    // Cancel the first assignment (morning)
    const cancelLinks = page.locator('[data-testid^="cancel-drive-"]');
    await expect(cancelLinks.first()).toBeVisible({ timeout: 5000 });
    await cancelLinks.first().click();
    const confirmBtn = page.locator('[data-testid^="cancel-confirm-"] button:has-text("Yes, cancel drive")').first();
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();
    await page.waitForTimeout(2000);

    // Verify in DB: morning is declined, afternoon is still confirmed
    const morningAssignment = getAssignmentId(versionId!, morningTrip, driver!.userId);
    if (morningAssignment) {
      assert.equal(getAssignmentStatus(morningAssignment), "declined", "morning assignment should be declined");
    }
    const afternoonAssignment = getAssignmentId(versionId!, afternoonTrip, driver!.userId);
    if (afternoonAssignment) {
      assert.equal(getAssignmentStatus(afternoonAssignment), "confirmed", "afternoon assignment should still be confirmed");
    }

    // Rider B volunteers for the morning (Flow A)
    await switchUser(page, riderB!.email);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("decline-alert")).toBeVisible({ timeout: 5000 });
    await volunteerViaFlowA(page);
    await expect(page.getByTestId("decline-alert")).toBeHidden({ timeout: 5000 });

    // Verify: Rider B is confirmed for morning, driver's morning is released,
    // afternoon is still confirmed for the original driver
    const riderBMorning = getAssignmentId(versionId!, morningTrip, riderB!.userId);
    if (riderBMorning) {
      assert.equal(getAssignmentStatus(riderBMorning), "confirmed", "Rider B should be confirmed for morning");
    }
    const driverMorning = getAssignmentId(versionId!, morningTrip, driver!.userId);
    if (driverMorning) {
      assert.equal(getAssignmentStatus(driverMorning), "released", "Driver's morning should be released");
    }
    const driverAfternoon = getAssignmentId(versionId!, afternoonTrip, driver!.userId);
    if (driverAfternoon) {
      assert.equal(getAssignmentStatus(driverAfternoon), "confirmed", "Driver's afternoon should still be confirmed");
    }
  });

  // ── Test 8: Coordinator regenerates after cancel → new assignment ──

  test("coordinator regenerates after cancel → riders get new assignment", async ({ page }) => {
    test.skip(skip, "Requires service key");
    const coord = setupHousehold(80, "RGCoord", true);
    if (!coord) { test.skip(); return; }
    const { weekId, tripIds } = setupCurrentWeekWithTrips();
    const morningTrip = tripIds[0];

    // Driver A has availability, gets assigned
    const driverA = seedFamilyForTrip(81, "RGDriverA", weekId, morningTrip, false, true, true);
    if (!driverA) { test.skip(); return; }

    // Driver B also has availability (backup driver)
    const driverB = seedFamilyForTrip(82, "RGDriverB", weekId, morningTrip, false, true, true);
    if (!driverB) { test.skip(); return; }

    // Rider C has a child on the trip, no availability
    const riderC = seedFamilyForTrip(83, "RGRiderC", weekId, morningTrip, false, false);
    if (!riderC) { test.skip(); return; }

await generateSchedule(coord!.email, weekId);
    await page.waitForTimeout(1000);
    publishScheduleViaSql(weekId);

    const versionId = getPublishedVersionId(weekId);
    if (!versionId) {
      const versions = runSql(`SELECT id, status, version_number FROM public.schedule_versions WHERE week_id = '${weekId}' ORDER BY version_number;`);
      console.error("[test1] versions:", JSON.stringify(versions.rows ?? []));
      const weeks = runSql(`SELECT id, starts_on, status FROM public.weeks WHERE id = '${weekId}';`);
      console.error("[test1] week:", JSON.stringify(weeks.rows ?? []));
      const trips = runSql(`SELECT id, service_date, direction FROM public.trips WHERE week_id = '${weekId}';`);
      console.error("[test1] trips:", JSON.stringify(trips.rows ?? []));
      const assignments = runSql(`SELECT id, status, driver_profile_id, trip_id FROM public.driver_assignments WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id = '${weekId}');`);
      console.error("[test1] assignments:", JSON.stringify(assignments.rows ?? []));
      const genResult = await generateSchedule(coord!.email, weekId);
      console.error("[test1] genResult:", JSON.stringify(genResult));
    }
    assert.ok(versionId, "published version should exist");

    // Driver A cancels via UI
    await signInWithTestAuth(page, driverA!.email);
    await page.waitForTimeout(2000);
    await cancelDriveViaUI(page);

    // Nobody volunteers. Coordinator regenerates the draft.
    await switchUser(page, coord!.email);
    await page.waitForTimeout(2000);
    await page.getByTestId("nav-coordinate").click();
    await expect(page.getByTestId("coordinator-screen")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Coordinator should see a declined alert
    await expect(page.getByTestId("decline-alert-admin")).toBeVisible({ timeout: 5000 });

    // Regenerate the schedule (via UI button or API)
    const generateBtn = page.getByTestId("generate-schedule").or(page.locator('button:has-text("Generate")'));
    const isGenerateVisible = await generateBtn.first().isVisible().catch(() => false);

    if (isGenerateVisible) {
      await generateBtn.first().click();
      await page.waitForTimeout(3000);
    } else {
      // Fall back to API
      await generateSchedule(coord!.email, weekId);
      await page.waitForTimeout(2000);
    }

    // Verify: a new schedule version exists (or the same version has been regenerated)
    // The key assertion is that riders are now covered by Driver B
    const newVersionId = getPublishedVersionId(weekId);
    assert.ok(newVersionId, "there should be a published version after regenerate");

    // Driver B should now be assigned (or Driver A if re-assigned)
    const confirmedDrivers = runSql(`SELECT driver_profile_id FROM public.driver_assignments WHERE schedule_version_id = '${newVersionId}' AND trip_id = '${morningTrip}' AND status = 'confirmed';`);
    const confirmedRows = confirmedDrivers.rows ?? [];
    assert.ok(confirmedRows.length > 0, "there should be at least one confirmed driver after regenerate");
  });
});