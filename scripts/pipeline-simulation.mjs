#!/usr/bin/env node
// Level 2: Full pipeline simulation against the live Supabase project.
// Creates 9 test households matching PRESSURE_TEST.md, invokes the deployed
// Edge Function, verifies the schedule output and audit events, prints a
// human-readable summary, then cleans up all test data.
//
// Usage: node scripts/pipeline-simulation.mjs
// Requires: Supabase CLI linked to project ujcrnrcgbvzyqosykkjy.

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_REF = "ujcrnrcgbvzyqosykkjy";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const GROUP_ID = "c1000000-0000-4000-8000-000000000001";

// Deterministic UUIDs for test data (all start with 'deadbeef' for easy cleanup)
const UID = (n) => `deadbeef-0000-4000-8000-${String(n).padStart(12, "0")}`;

const households = [
  { name: "Adams Test",   children: 2, seats: 4, maxDrives: 3, drives: true,  coordinator: true },
  { name: "Bennett Test", children: 1, seats: 3, maxDrives: 4, drives: true },
  { name: "Chen Test",    children: 2, seats: 5, maxDrives: 5, drives: true },
  { name: "Diaz Test",    children: 1, seats: 0, maxDrives: 0, drives: false },
  { name: "Evans Test",   children: 1, seats: 3, maxDrives: 2, drives: true },
  { name: "Foster Test",  children: 1, seats: 4, maxDrives: 5, drives: true },
  { name: "Garcia Test",  children: 2, seats: 3, maxDrives: 4, drives: true },
  { name: "Hughes Test",  children: 1, seats: 4, maxDrives: 5, drives: true },
  { name: "Irwin Test",   children: 1, seats: 3, maxDrives: 3, drives: true },
];

const childNames = [
  ["Ava", "Adams"], ["Ben", "Adams"],
  ["Cleo", "Bennett"],
  ["Dan", "Chen"], ["Eve", "Chen"],
  ["Frank", "Diaz"],
  ["Gia", "Evans"],
  ["Hugo", "Foster"],
  ["Iris", "Garcia"], ["Jack", "Garcia"],
  ["Kate", "Hughes"],
  ["Leo", "Irwin"],
];

function getSupabaseToken() {
  try {
    return execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not get Supabase access token from keychain");
  }
}

function getServiceRoleKey(cliToken) {
  const result = execSync(
    `curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`,
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(result);
  const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
  for (const k of keyList) {
    if (k.prefix === "iAHHB") return k.api_key;
  }
  throw new Error("Could not find legacy service_role key");
}

function fetchJson(url, options = {}) {
  const { execSync: es } = require("node:child_process");
  const headers = options.headers || {};
  const cmd = `curl -s ${Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ")} ${options.method ? `-X ${options.method}` : ""} -d '${options.body || ""}' "${url}"`;
  const result = es(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(result);
}

async function main() {
  console.log("=== Pipeline Simulation ===\n");

  const cliToken = getSupabaseToken();
  const serviceKey = getServiceRoleKey(cliToken);
  const authHeaders = {
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  // ── 1. Create test auth users ────────────────────────────────
  console.log("1. Creating 9 test users...");
  const userIds = [];
  for (let i = 0; i < households.length; i++) {
    const email = `${households[i].name.split(" ")[0].toLowerCase()}@test.kidpool`;
    const userId = UID(i + 1);
    userIds.push(userId);

    const body = JSON.stringify({
      id: userId,
      email,
      password: "TestPass123!",
      email_confirm: true,
      user_metadata: { full_name: households[i].name },
    });

    execSync(
      `curl -s -X POST -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/admin/users" > /dev/null`,
      { encoding: "utf8" },
    );
    process.stdout.write(".");
  }
  console.log(" done\n");

  // ── 2. Seed data via SQL ──────────────────────────────────────
  console.log("2. Seeding households, children, vehicles, week, check-ins...");
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-"));
  const seedFile = path.join(tmpDir, "seed.sql");

  let sql = "";
  const weekId = UID(100);
  const tripIds = [];
  const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];

  // Profiles
  for (let i = 0; i < households.length; i++) {
    const email = `${households[i].name.split(" ")[0].toLowerCase()}@test.kidpool`;
    sql += `INSERT INTO public.profiles (id, email, full_name) VALUES ('${userIds[i]}', '${email}', '${households[i].name}') ON CONFLICT (id) DO NOTHING;\n`;
  }

  // Households + memberships
  for (let i = 0; i < households.length; i++) {
    const hId = UID(100 + i);
    sql += `INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${hId}', '${GROUP_ID}', '${households[i].name}', '${userIds[i]}') ON CONFLICT (id) DO NOTHING;\n`;
    const role = households[i].coordinator ? "coordinator" : "member";
    sql += `INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${hId}', '${userIds[i]}', '${role}', 'active') ON CONFLICT DO NOTHING;\n`;
    households[i].householdId = hId;
  }

  // Children
  let childIdx = 0;
  for (let i = 0; i < households.length; i++) {
    for (let j = 0; j < households[i].children; j++) {
      const cId = UID(200 + childIdx);
      const [fn, ln] = childNames[childIdx];
      sql += `INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${cId}', '${GROUP_ID}', '${households[i].householdId}', '${fn}', '${ln}', '${userIds[i]}') ON CONFLICT (id) DO NOTHING;\n`;
      households[i].childIds = households[i].childIds || [];
      households[i].childIds.push(cId);
      childIdx++;
    }
  }

  // Vehicles
  for (let i = 0; i < households.length; i++) {
    if (!households[i].drives) continue;
    const vId = UID(300 + i);
    sql += `INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${vId}', '${GROUP_ID}', '${households[i].householdId}', '${households[i].name} Car', ${households[i].seats}, '${userIds[i]}') ON CONFLICT (id) DO NOTHING;\n`;
    households[i].vehicleId = vId;
  }

  // Week + trips
  sql += `INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${weekId}', '${GROUP_ID}', '2026-08-03', 'open') ON CONFLICT (id) DO NOTHING;\n`;
  for (let d = 0; d < 5; d++) {
    for (const dir of ["morning", "afternoon"]) {
      const tId = UID(400 + d * 2 + (dir === "morning" ? 0 : 1));
      tripIds.push(tId);
      sql += `INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${tId}', '${GROUP_ID}', '${weekId}', '${dates[d]}', '${dir}', '07:35', '07:40', 'Midtown Terrace', 'Presidio Middle School') ON CONFLICT (id) DO NOTHING;\n`;
    }
  }

  // Check-ins + ride requests + driver availability
  const riderCounts = [12, 10, 12, 12, 11, 9, 12, 12, 12, 8];
  const allChildren = households.flatMap((h) => h.childIds || []);
  for (let i = 0; i < households.length; i++) {
    const cId = UID(500 + i);
    sql += `INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${cId}', '${GROUP_ID}', '${weekId}', '${households[i].householdId}', 'submitted', ${households[i].maxDrives}) ON CONFLICT (id) DO NOTHING;\n`;
    households[i].checkinId = cId;

    // Ride requests: all children need rides on all trips (simplified)
    for (const tId of tripIds) {
      for (const childId of (households[i].childIds || [])) {
        sql += `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${cId}', '${tId}', '${childId}', true, '${userIds[i]}') ON CONFLICT DO NOTHING;\n`;
      }
    }

    // Driver availability
    if (households[i].drives && households[i].vehicleId) {
      for (let d = 0; d < 5; d++) {
        const morningPref = d % 2 === 0 ? "prefer" : "can";
        const afternoonPref = d % 2 === 1 ? "prefer" : "can";
        sql += `INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${cId}', '${tripIds[d * 2]}', '${userIds[i]}', '${households[i].vehicleId}', '${morningPref}') ON CONFLICT DO NOTHING;\n`;
        sql += `INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${cId}', '${tripIds[d * 2 + 1]}', '${userIds[i]}', '${households[i].vehicleId}', '${afternoonPref}') ON CONFLICT DO NOTHING;\n`;
      }
    }
  }

  writeFileSync(seedFile, sql);
  execSync(`supabase db query --linked -f "${seedFile}"`, { encoding: "utf8", stdio: "pipe" });
  unlinkSync(seedFile);
  console.log("   Seeded 9 households, 12 children, 8 vehicles, 1 week, 10 trips, 9 check-ins\n");

  // ── 3. Get coordinator JWT ────────────────────────────────────
  console.log("3. Signing in as coordinator...");
  const coordEmail = "adams@test.kidpool";
  const signInBody = JSON.stringify({ email: coordEmail, password: "TestPass123!" });
  const tokenResult = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${serviceKey}" -H "Content-Type: application/json" -d '${signInBody}' "${SUPABASE_URL}/auth/v1/token?grant_type=password"`,
    { encoding: "utf8" },
  ));
  const jwt = tokenResult.access_token;
  if (!jwt) {
    console.error("Failed to get JWT:", tokenResult);
    throw new Error("Could not sign in as coordinator");
  }
  console.log("   Got JWT\n");

  // ── 4. Invoke Edge Function ──────────────────────────────────
  console.log("4. Invoking generate-schedule Edge Function...");
  const fnBody = JSON.stringify({ weekId });
  const fnResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${jwt}" -H "apikey: ${serviceKey}" -H "Content-Type: application/json" -d '${fnBody}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  console.log("   Result:", fnResult.success ? "SUCCESS" : "FAILED");
  if (!fnResult.success) {
    console.error("   Error:", fnResult.error);
    throw new Error("Edge function failed");
  }

  // ── 5. Print schedule summary ────────────────────────────────
  console.log("\n5. Schedule summary:\n");
  const profileById = new Map(userIds.map((id, i) => [id, households[i].name]));
  for (const trip of fnResult.trips) {
    const tripIdx = tripIds.indexOf(trip.trip_id);
    const day = Math.floor(tripIdx / 2);
    const dir = tripIdx % 2 === 0 ? "AM" : "PM";
    const status = trip.uncovered ? "UNCOVERED" : "covered";
    console.log(`  ${dates[day]} ${dir}: ${trip.rider_count} riders, ${trip.driver_count} drivers, ${trip.assigned_rider_count}/${trip.rider_count} assigned [${status}]`);
  }

  // ── 6. Verify DB writes ──────────────────────────────────────
  console.log("\n6. Verifying DB writes...");
  const versionResult = JSON.parse(execSync(
    `curl -s -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" "${SUPABASE_URL}/rest/v1/schedule_versions?week_id=eq.${weekId}&select=id,version_number,status,algorithm_version"`,
    { encoding: "utf8" },
  ));
  console.log("   Schedule versions:", JSON.stringify(versionResult));

  const driverAssignments = JSON.parse(execSync(
    `curl -s -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" "${SUPABASE_URL}/rest/v1/driver_assignments?schedule_version_id=eq.${versionResult[0].id}&select=id,driver_profile_id,status"`,
    { encoding: "utf8" },
  ));
  console.log(`   Driver assignments: ${driverAssignments.length} total`);

  const riderAssignments = JSON.parse(execSync(
    `curl -s -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" "${SUPABASE_URL}/rest/v1/rider_assignments?schedule_version_id=eq.${versionResult[0].id}&select=id,child_id"`,
    { encoding: "utf8" },
  ));
  console.log(`   Rider assignments: ${riderAssignments.length} total`);

  const auditEvents = JSON.parse(execSync(
    `curl -s -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" "${SUPABASE_URL}/rest/v1/audit_events?group_id=eq.${GROUP_ID}&action=eq.schedule_generated&select=id,action,details"`,
    { encoding: "utf8" },
  ));
  console.log(`   Audit events (schedule_generated): ${auditEvents.length}`);

  const allGood = versionResult.length > 0 && driverAssignments.length > 0 && riderAssignments.length > 0 && auditEvents.length > 0;
  console.log(allGood ? "\n   ALL VERIFICATIONS PASSED\n" : "\n   VERIFICATION FAILED\n");

  // ── 7. Cleanup ───────────────────────────────────────────────
  console.log("7. Cleaning up test data...");
  const cleanupFile = path.join(tmpDir, "cleanup.sql");
  let cleanupSql = "";
  // Delete in reverse dependency order
  cleanupSql += `DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND entity_id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.driver_confirmations WHERE group_id = '${GROUP_ID}';\n`;
  cleanupSql += `DELETE FROM public.rider_assignments WHERE group_id = '${GROUP_ID}' AND schedule_version_id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.driver_assignments WHERE group_id = '${GROUP_ID}' AND schedule_version_id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.schedule_versions WHERE group_id = '${GROUP_ID}' AND week_id = '${weekId}';\n`;
  cleanupSql += `DELETE FROM public.driver_availability WHERE group_id = '${GROUP_ID}' AND checkin_id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.ride_requests WHERE group_id = '${GROUP_ID}' AND checkin_id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND week_id = '${weekId}';\n`;
  cleanupSql += `DELETE FROM public.trips WHERE group_id = '${GROUP_ID}' AND week_id = '${weekId}';\n`;
  cleanupSql += `DELETE FROM public.weeks WHERE id = '${weekId}';\n`;
  cleanupSql += `DELETE FROM public.vehicles WHERE group_id = '${GROUP_ID}' AND id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.children WHERE group_id = '${GROUP_ID}' AND id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.memberships WHERE group_id = '${GROUP_ID}' AND household_id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id LIKE 'deadbeef%';\n`;
  cleanupSql += `DELETE FROM public.profiles WHERE id LIKE 'deadbeef%';\n`;

  writeFileSync(cleanupFile, cleanupSql);
  try {
    execSync(`supabase db query --linked -f "${cleanupFile}"`, { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    console.log("   Cleanup SQL had errors (non-fatal):", e.message?.slice(0, 200));
  }
  unlinkSync(cleanupFile);

  // Delete auth users
  for (const userId of userIds) {
    execSync(
      `curl -s -X DELETE -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" "${SUPABASE_URL}/auth/v1/admin/users/${userId}" > /dev/null`,
      { encoding: "utf8" },
    );
  }
  console.log("   Deleted 9 auth users + all test data\n");

  console.log("=== Pipeline Simulation Complete ===");
  console.log(allGood ? "RESULT: PASS\n" : "RESULT: FAIL\n");
  process.exit(allGood ? 0 : 1);
}

main().catch((err) => {
  console.error("Pipeline simulation failed:", err);
  process.exit(1);
});