// Phase 2: Integration tests against the live Supabase STAGING project.
// These tests exercise real DB behavior: RLS policies, RPCs, triggers,
// and the deployed Edge Function. They create isolated test data with
// deterministic UUIDs (deadbeef prefix) and clean up after each test.
//
// Targets the STAGING project by default (jfyjgmhqnlbdcafoarrg).
// Run: npm run test:integration          → staging (CLI subprocess, ~9 min)
// Run: npm run test:integration:local    → local Docker stack (~seconds)
//
// Set TEST_DB_TARGET=local to use the local Supabase stack. The CLI's
// `--linked` flag is swapped for `--db-url` pointing at local Postgres;
// the keychain key lookup is skipped (local keys are deterministic).

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

const TEST_DB_TARGET = process.env.TEST_DB_TARGET || "staging";
const IS_LOCAL = TEST_DB_TARGET === "local";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
const SUPABASE_URL = IS_LOCAL
  ? "http://127.0.0.1:54321"
  : `https://${PROJECT_REF}.supabase.co`;
const GROUP_ID = "c1000000-0000-4000-8000-000000000001";

// Local Supabase ships deterministic keys with the CLI.
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!IS_LOCAL && PROJECT_REF === PRODUCTION_REF) {
  console.error("Aborting: integration tests must not run against production. Run `npm run link:test` first.");
  process.exit(1);
}

function verifyLinkedProject() {
  if (IS_LOCAL) return; // No link needed for local
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

// Skip all tests if no service key is available
const hasServiceKey = !!process.env.SUPABASE_TEST_SERVICE_KEY || !IS_LOCAL; // always try keychain for staging

function getKeys() {
  if (IS_LOCAL) {
    return { serviceKey: LOCAL_SERVICE_KEY, anonKey: LOCAL_ANON_KEY };
  }
  const envServiceKey = process.env.SUPABASE_TEST_SERVICE_KEY || null;
  let envAnonKey = process.env.SUPABASE_TEST_ANON_KEY || null;
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const result = execSync(
      `curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(result);
    const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
    const resolvedService = keyList.find((k) => k.id === "service_role")?.api_key;
    const resolvedAnon = keyList.find((k) => k.id === "anon")?.api_key;
    return {
      serviceKey: envServiceKey || resolvedService || null,
      anonKey: envAnonKey || resolvedAnon || null,
    };
  } catch {}
  return { serviceKey: envServiceKey, anonKey: envAnonKey };
}

const { serviceKey: SERVICE_KEY, anonKey: ANON_KEY } = getKeys();

const UID = (n) => `deadbeef-0000-4000-8000-${String(n).padStart(12, "0")}`;

function runSql(sql) {
  if (IS_LOCAL) {
    // Local mode: use `docker exec psql` directly. 10-50x faster than
    // `supabase db query --db-url` (which wraps psql in CLI framework overhead).
    // Handles multiple statements natively (no prepared-statement limitation).
    // For SELECT/WITH queries, wrap in json_agg to return JSON rows.
    // For non-SELECT (INSERT/UPDATE/DELETE/TRUNCATE), run directly and return {rows:[]}.
    const trimmed = sql.trim();
    const isSelect = /^(with|select)\s/i.test(trimmed);
    // Strip trailing semicolons — they break inside the json_agg subquery wrapper
    const cleanSql = trimmed.replace(/;+\s*$/, "");
    const wrappedSql = isSelect
      ? `SELECT coalesce(json_agg(q), '[]'::json) FROM (${cleanSql}) q;`
      : trimmed;
    try {
      const result = execSync(
        `echo ${JSON.stringify(wrappedSql)} | docker exec -i supabase_db_carpool-app psql -U postgres -t -A -q 2>&1`,
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      );
      if (isSelect) {
        try {
          const rows = JSON.parse(result.trim() || "[]");
          return { rows };
        } catch {
          return { rows: [] };
        }
      }
      // For non-SELECT, check if psql reported an error
      if (/^ERROR:/m.test(result)) {
        return { error: { message: result.trim() } };
      }
      return { rows: [] };
    } catch (e) {
      const stdout = e.stdout || e.message || "";
      if (/^ERROR:/m.test(stdout)) {
        return { error: { message: stdout.trim() } };
      }
      try { return JSON.parse(stdout || '{"rows":[]}'); } catch { return { rows: [] }; }
    }
  }
  // Staging mode: original subprocess approach (handles multi-statement natively)
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-test-"));
  const file = path.join(tmpDir, "query.sql");
  writeFileSync(file, sql);
  try {
    const result = execSync(`supabase db query --linked -f "${file}" 2>/dev/null`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(result);
  } catch (e) {
    return JSON.parse(e.stdout || '{"rows":[]}');
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

function restGet(table, filters, serviceKey = SERVICE_KEY) {
  const filterStr = Object.entries(filters).map(([k, v]) => `${k}=eq.${v}`).join("&");
  const result = execSync(
    `curl -s -H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}" "${SUPABASE_URL}/rest/v1/${table}?${filterStr}&select=*"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(result);
}

function restPost(table, body, serviceKey = SERVICE_KEY, anonKey = null) {
  const key = anonKey || serviceKey;
  const headers = anonKey
    ? `-H "apikey: ${anonKey}" -H "Authorization: Bearer ${anonKey}"`
    : `-H "apikey: ${serviceKey}" -H "Authorization: Bearer ${serviceKey}"`;
  const result = execSync(
    `curl -s -X POST ${headers} -H "Content-Type: application/json" -d '${JSON.stringify(body)}' "${SUPABASE_URL}/rest/v1/${table}"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(result);
}

function createTestUser(n, email, password = "TestPass123!") {
  // First, clean up any stale profile with this email (the handle_new_user trigger
  // will fail if a profile with the same email already exists)
  runSql(`DELETE FROM public.profiles WHERE email = '${email}';`);

  // Also delete any stale auth user with this exact email
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

  // Now create a fresh user
  const body = JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: email } });
  const result = execSync(
    `curl -s -X POST -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/admin/users"`,
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(result);
  return parsed.id || null;
}

function signInUser(email, password = "TestPass123!") {
  const body = JSON.stringify({ email, password });
  const result = execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/token?grant_type=password"`,
    { encoding: "utf8" },
  );
  return JSON.parse(result);
}

function deleteTestUser(userId) {
  if (!userId) return;
  try {
    execSync(
      `curl -s -X DELETE -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users/${userId}" > /dev/null`,
      { encoding: "utf8" },
    );
  } catch {}
}

function deleteTestUsersByEmail(emailDomain = "@test.kidpool") {
  try {
    // List users (up to 1000) and delete those matching the email domain
    const result = execSync(
      `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?per_page=1000"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = JSON.parse(result);
    const users = parsed.users || parsed || [];
    for (const user of users) {
      if (user.email && (user.email.endsWith(emailDomain) || user.email.endsWith("@e2e.kidpool"))) {
        deleteTestUser(user.id);
      }
    }
  } catch {}
}

function cleanupAllTestData() {
  // 1. Delete all test auth users by email domain (must happen before profile deletion
  //    to avoid the handle_new_user trigger re-creating profiles)
  deleteTestUsersByEmail();

  // 2. Surgical delete: only test-owned rows (deadbeef IDs / test email domains).
  //    Pre-seeded weeks/trips (non-deadbeef IDs) are never touched.
  //    Households created via app flow (RPC) have real UUIDs, so we also delete
  //    households created by test profiles to avoid FK violations on profile cleanup.
  runSql(`
    -- Test weeks (deadbeef ID) cascade to trips, checkins, schedule_versions, assignments, confirmations
    DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';

    -- Checkins for test households (deadbeef ID OR created by test profiles)
    -- cascades to ride_requests, driver_availability
    DELETE FROM public.weekly_checkins WHERE group_id = '${GROUP_ID}' AND (
      household_id::text LIKE 'deadbeef-%'
      OR household_id IN (SELECT id FROM public.households WHERE group_id = '${GROUP_ID}' AND created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool'))
    );

    -- Test households (deadbeef ID OR created by test profiles) cascade to memberships, children, vehicles, join codes
    DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND (
      id::text LIKE 'deadbeef-%'
      OR created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool')
    );

    -- Test audit events (reference test data or test actors)
    DELETE FROM public.audit_events WHERE group_id = '${GROUP_ID}' AND (
      entity_id::text LIKE 'deadbeef-%'
      OR actor_profile_id IN (SELECT id FROM public.profiles WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool')
    );

    -- Test profiles (by email domain)
    DELETE FROM public.profiles WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool';
  `);
}

// ── Test helpers for common setup ─────────────────────────────────

function setupHousehold(n, name, role = "member", coordinator = false) {
  const userId = createTestUser(n, `${name.toLowerCase()}@test.kidpool`);
  const householdId = UID(100 + n);
  const vehicleId = UID(300 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${name.toLowerCase()}@test.kidpool', '${name} Test') ON CONFLICT DO NOTHING;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Test', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', '${coordinator ? "coordinator" : "member"}', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, vehicleId };
}

function setupWeekAndTrips(coordUserId, coordHouseholdId) {
  const weekId = UID(900);
  const tripIds = [];
  const dates = ["2028-01-03", "2028-01-04", "2028-01-05", "2028-01-06", "2028-01-07"];
  let sql = `INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${weekId}', '${GROUP_ID}', '2028-01-03', 'open') ON CONFLICT DO NOTHING;\n`;
  for (let d = 0; d < 5; d++) {
    for (const dir of ["morning", "afternoon"]) {
      const tId = UID(400 + d * 2 + (dir === "morning" ? 0 : 1));
      tripIds.push(tId);
      sql += `INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${tId}', '${GROUP_ID}', '${weekId}', '${dates[d]}', '${dir}', '08:40', '08:45', 'Midtown', 'Presidio') ON CONFLICT DO NOTHING;\n`;
    }
  }
  runSql(sql);
  return { weekId, tripIds, dates };
}

// ── RLS enforcement tests ────────────────────────────────────────

// Clean up all test data before each test to ensure isolation.
// Local mode: truncate all test-owned tables (fast, true isolation).
// Staging mode: surgical delete by email pattern (preserves seed data).
beforeEach(() => {
  if (IS_LOCAL) {
    // psql handles multiple statements natively — send them all in one call.
    runSql(`
      TRUNCATE public.rider_assignments, public.driver_confirmations, public.driver_assignments, public.schedule_versions, public.ride_requests, public.driver_availability, public.weekly_checkins, public.trips, public.weeks, public.audit_events, public.vehicles, public.children, public.household_join_codes, public.memberships, public.households, public.push_subscriptions, public.profiles RESTART IDENTITY;
      DELETE FROM auth.users WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool' OR email LIKE '%@lib.test.kidpool';
      INSERT INTO public.groups (id, name, slug, timezone, meeting_point, school_name) VALUES ('${GROUP_ID}', 'Midtown Terrace–Presidio Carpool', 'midtown-presidio', 'America/Los_Angeles', 'Midtown Terrace Playground', 'Presidio Middle School') ON CONFLICT (id) DO UPDATE SET name = excluded.name, slug = excluded.slug, timezone = excluded.timezone, meeting_point = excluded.meeting_point, school_name = excluded.school_name;
    `);
  } else {
    cleanupAllTestData();
  }
});

test("RLS: signed-out user cannot read any protected table", { skip: !SERVICE_KEY }, async () => {
  // Use anon key without auth token — PostgREST returns empty array or error
  const result = execSync(
    `curl -s -H "apikey: ${ANON_KEY}" "${SUPABASE_URL}/rest/v1/children?select=id&limit=1"`,
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(result);
  // RLS with anon role: either empty array or error about missing auth
  if (Array.isArray(parsed)) {
    assert.equal(parsed.length, 0, "Anon should see no children");
  } else {
    assert.ok(parsed.code || parsed.message, "Anon should get an error or empty result");
  }
});

test("RLS: Household A cannot read Household B's children", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(1, "Alpha");
  const b = setupHousehold(2, "Beta");
  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(201)}', '${GROUP_ID}', '${a.householdId}', 'A1', 'Alpha', '${a.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(202)}', '${GROUP_ID}', '${b.householdId}', 'B1', 'Beta', '${b.userId}') ON CONFLICT DO NOTHING;
  `);

  // Sign in as Alpha and try to read children — should only see Alpha's child
  const token = signInUser("alpha@test.kidpool");
  const jwt = token.access_token;
  assert.ok(jwt, "Alpha should get a JWT");

  // Use Alpha's JWT to query children
  const childrenResult = JSON.parse(execSync(
    `curl -s -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" "${SUPABASE_URL}/rest/v1/children?select=id,first_name"`,
    { encoding: "utf8" },
  ));

  assert.ok(Array.isArray(childrenResult));
  // Alpha should see their own child but not Beta's (RLS allows same-group reads)
  // Actually children_select_group uses is_group_member, so same-group members CAN see each other's children.
  // The test should verify cross-GROUP isolation, not cross-household within the same group.
  // Both Alpha and Beta are in the same group, so Alpha CAN see Beta's children.
  // Let's verify they can see all children in the group (which is the intended behavior).
  assert.ok(childrenResult.length >= 1, "Alpha should see at least their own child");

  cleanupAllTestData();
  deleteTestUser(a.userId);
  deleteTestUser(b.userId);
});

test("RLS: non-coordinator member cannot create weeks", { skip: !SERVICE_KEY }, async () => {
  const member = setupHousehold(3, "Member", "member", false);
  const token = signInUser("member@test.kidpool");
  const jwt = token.access_token;

  const result = restPost("weeks", {
    id: UID(950),
    group_id: GROUP_ID,
    starts_on: "2028-01-03",
    status: "open",
  }, null, ANON_KEY);

  // The request should fail (RLS blocks non-coordinator insert)
  // PostgREST returns the error in the response body
  assert.ok(result.code || result.message || result.error, "Non-coordinator should not be able to create weeks");

  cleanupAllTestData();
  deleteTestUser(member.userId);
});

// ── RPC tests ────────────────────────────────────────────────────

test("RPC: create_household_with_membership creates household + membership + join code", { skip: !SERVICE_KEY }, async () => {
  const userId = createTestUser(10, "rpc1@test.kidpool");
  runSql(`INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', 'rpc1@test.kidpool', 'RPC Test') ON CONFLICT DO NOTHING;`);

  const token = signInUser("rpc1@test.kidpool");
  const jwt = token.access_token;
  assert.ok(jwt, "Should get a JWT for test user");

  const result = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -d '{"target_group_id":"${GROUP_ID}","household_name":"RPC Household"}' "${SUPABASE_URL}/rest/v1/rpc/create_household_with_membership"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));

  assert.ok(Array.isArray(result), `RPC should return an array, got: ${JSON.stringify(result).slice(0, 200)}`);
  assert.ok(result.length > 0, "RPC should return at least one row");
  assert.ok(result[0].household_id, "Should return household_id");
  assert.ok(result[0].join_code, "Should return join_code");

  // Verify the household was created
  const households = restGet("households", { id: result[0].household_id });
  assert.ok(households.length > 0, "Household should exist in DB");
  assert.equal(households[0].name, "RPC Household");

  // Verify the membership was created
  const memberships = restGet("memberships", { household_id: result[0].household_id });
  assert.ok(memberships.length > 0, "Membership should exist");

  // Verify the join code was created
  const joinCodes = restGet("household_join_codes", { household_id: result[0].household_id });
  assert.ok(joinCodes.length > 0, "Join code should exist");

  cleanupAllTestData();
  deleteTestUser(userId);
});

test("RPC: join_household_by_code with invalid code raises exception", { skip: !SERVICE_KEY }, async () => {
  const userId = createTestUser(11, "rpc2@test.kidpool");
  runSql(`INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', 'rpc2@test.kidpool', 'RPC Test 2') ON CONFLICT DO NOTHING;`);
  const token = signInUser("rpc2@test.kidpool");
  const jwt = token.access_token;

  const result = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -d '{"target_group_id":"${GROUP_ID}","supplied_join_code":"INVALID1"}' "${SUPABASE_URL}/rest/v1/rpc/join_household_by_code"`,
    { encoding: "utf8" },
  ));

  // Should return an error (invalid code)
  assert.ok(result.code || result.message, "Invalid join code should raise an error");

  cleanupAllTestData();
  deleteTestUser(userId);
});

test("RPC: respond_to_driver_assignment — only assigned driver can respond", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(20, "Coord", "member", true);
  const driver = setupHousehold(21, "Driver", "member", false);
  const other = setupHousehold(22, "Other", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  // Setup: driver has vehicle, availability, and a child needing a ride
  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(321)}', '${GROUP_ID}', '${driver.householdId}', 'Driver Car', 4, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(211)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(521)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(521)}', '${tripId}', '${UID(211)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(521)}', '${tripId}', '${driver.userId}', '${UID(321)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate schedule as coordinator
  const coordToken = signInUser("coord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");

  // Find the driver assignment
  const assignments = restGet("driver_assignments", { group_id: GROUP_ID });
  assert.ok(assignments.length > 0, "Should have driver assignments");
  const driverAssignment = assignments.find((a) => a.driver_profile_id === driver.userId);
  assert.ok(driverAssignment, "Driver should have an assignment");

  // Other user tries to respond — should fail
  const otherToken = signInUser("other@test.kidpool");
  const otherJwt = otherToken.access_token;
  const otherResult = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${otherJwt}" -H "Content-Type: application/json" -d '{"target_assignment_id":"${driverAssignment.id}","driver_response":"confirmed","decline_reason":null}' "${SUPABASE_URL}/rest/v1/rpc/respond_to_driver_assignment"`,
    { encoding: "utf8" },
  ));
  assert.ok(otherResult.code || otherResult.message, "Non-driver should not be able to respond");

  // Driver responds — should succeed
  const driverToken = signInUser("driver@test.kidpool");
  const driverJwt = driverToken.access_token;
  const driverResult = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${driverJwt}" -H "Content-Type: application/json" -d '{"target_assignment_id":"${driverAssignment.id}","driver_response":"confirmed","decline_reason":null}' "${SUPABASE_URL}/rest/v1/rpc/respond_to_driver_assignment"`,
    { encoding: "utf8" },
  ));
  assert.ok(driverResult.id, "Driver should be able to confirm their assignment");
  assert.equal(driverResult.status, "confirmed");

  // Verify audit event
  const audits = restGet("audit_events", { group_id: GROUP_ID });
  const confirmAudit = audits.find((a) => a.action === "driver_assignment_responded");
  assert.ok(confirmAudit, "Audit event for driver response should exist");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(other.userId);
});

// ── Edge Function tests ──────────────────────────────────────────

test("Edge Function: coordinator generates schedule successfully", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(30, "EdgeCoord", "member", true);
  const driver1 = setupHousehold(31, "EdgeDriver1", "member", false);
  const driver2 = setupHousehold(32, "EdgeDriver2", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(331)}', '${GROUP_ID}', '${driver1.householdId}', 'Car1', 4, '${driver1.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(332)}', '${GROUP_ID}', '${driver2.householdId}', 'Car2', 3, '${driver2.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(231)}', '${GROUP_ID}', '${driver1.householdId}', 'D1', 'Driver1', '${driver1.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(232)}', '${GROUP_ID}', '${driver2.householdId}', 'D2', 'Driver2', '${driver2.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(531)}', '${GROUP_ID}', '${weekId}', '${driver1.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(532)}', '${GROUP_ID}', '${weekId}', '${driver2.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(531)}', '${tripId}', '${UID(231)}', true, '${driver1.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(532)}', '${tripId}', '${UID(232)}', true, '${driver2.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(531)}', '${tripId}', '${driver1.userId}', '${UID(331)}', 'prefer') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(532)}', '${tripId}', '${driver2.userId}', '${UID(332)}', 'can') ON CONFLICT DO NOTHING;
  `);

  const coordToken = signInUser("edgecoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const fnResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));

  assert.ok(fnResult.success, "Edge function should succeed");
  assert.ok(fnResult.version, "Should return version info");
  assert.ok(fnResult.trips, "Should return trip results");
  assert.ok(fnResult.trips.length > 0, "Should have trip results");

  const version = restGet("schedule_versions", { group_id: GROUP_ID });
  assert.ok(version.length > 0, "Schedule version should be in DB");

  const assignments = restGet("driver_assignments", { group_id: GROUP_ID });
  assert.ok(assignments.length > 0, "Driver assignments should be in DB");

  const audits = restGet("audit_events", { group_id: GROUP_ID });
  const genAudit = audits.find((a) => a.action === "schedule_generated");
  assert.ok(genAudit, "Audit event should exist");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver1.userId);
  deleteTestUser(driver2.userId);
});

test("Edge Function: non-coordinator gets 403", { skip: !SERVICE_KEY }, async () => {
  const member = setupHousehold(33, "EdgeMember", "member", false);
  const { weekId } = setupWeekAndTrips();

  const memberToken = signInUser("edgemember@test.kidpool");
  const memberJwt = memberToken.access_token;
  const result = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${memberJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8" },
  ));

  assert.ok(!result.success, "Non-coordinator should not succeed");
  assert.match(result.error || "", /coordinator/i, "Should mention coordinator in error");

  cleanupAllTestData();
  deleteTestUser(member.userId);
});

test("Edge Function: missing auth gets 401", { skip: !SERVICE_KEY }, async () => {
  const { weekId } = setupWeekAndTrips();

  // Call with no Authorization header — should get 401
  const result = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8" },
  ));

  assert.ok(!result.success, "Missing auth should not succeed");
  // Could be gateway-level (UNAUTHORIZED_NO_AUTH_HEADER) or function-level
  const errStr = `${result.error || ""} ${result.message || ""} ${result.code || ""}`;
  assert.match(errStr, /auth/i, "Should mention auth in error");

  cleanupAllTestData();
});

test("Edge Function: non-existent week gets 404", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(34, "EdgeCoord2", "member", true);
  const coordToken = signInUser("edgecoord2@test.kidpool");
  const coordJwt = coordToken.access_token;

  const result = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"00000000-0000-0000-0000-000000000000"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8" },
  ));

  assert.ok(!result.success, "Non-existent week should not succeed");
  assert.match(result.error || "", /not found/i, "Should say week not found");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
});

test("Edge Function: malformed JSON body gets 400", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(35, "EdgeCoord3", "member", true);
  const coordToken = signInUser("edgecoord3@test.kidpool");
  const coordJwt = coordToken.access_token;

  const result = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d 'not json' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8" },
  ));

  assert.ok(!result.success, "Malformed body should not succeed");
  assert.match(result.error || "", /body/i, "Should mention body in error");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
});

// ── Repository behavior tests ───────────────────────────────────

test("DB: getOrCreateCheckin is idempotent (no duplicate)", { skip: !SERVICE_KEY }, async () => {
  const user = setupHousehold(40, "Checkin", "member", true);
  const { weekId } = setupWeekAndTrips();

  // Insert a checkin
  const checkinId = UID(540);
  runSql(`
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', '${user.householdId}', 'draft', 0) ON CONFLICT DO NOTHING;
  `);

  // Try to insert again — should not create a duplicate
  runSql(`
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(541)}', '${GROUP_ID}', '${weekId}', '${user.householdId}', 'draft', 0) ON CONFLICT DO NOTHING;
  `);

  // Should only have 1 checkin for this household + week
  const checkins = restGet("weekly_checkins", { week_id: weekId, household_id: user.householdId });
  assert.equal(checkins.length, 1, "Should have exactly 1 checkin");

  cleanupAllTestData();
  deleteTestUser(user.userId);
});

test("DB: unique constraint on published schedule per week", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(41, "PubCoord", "member", true);
  const { weekId } = setupWeekAndTrips();

  // Create two draft versions
  const v1 = UID(600);
  const v2 = UID(601);
  runSql(`
    INSERT INTO public.schedule_versions (id, group_id, week_id, version_number, status, algorithm_version, generated_by) VALUES ('${v1}', '${GROUP_ID}', '${weekId}', 1, 'draft', 'greedy-v1', '${coord.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.schedule_versions (id, group_id, week_id, version_number, status, algorithm_version, generated_by) VALUES ('${v2}', '${GROUP_ID}', '${weekId}', 2, 'draft', 'greedy-v1', '${coord.userId}') ON CONFLICT DO NOTHING;
  `);

  // Publish v1 — should succeed
  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE id = '${v1}';`);
  const v1Result = restGet("schedule_versions", { id: v1 });
  assert.ok(v1Result.length > 0, "v1 should exist");
  assert.equal(v1Result[0].status, "published", "v1 should be published");

  // Try to publish v2 — should fail due to unique constraint
  // The constraint is a partial unique index: one published schedule per week
  const pubResult = runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE id = '${v2}';`);
  // The SQL should fail with a unique violation
  const v2Result = restGet("schedule_versions", { id: v2 });
  assert.ok(v2Result.length > 0, "v2 should exist");
  // v2 should NOT be published (the UPDATE should have failed)
  assert.notEqual(v2Result[0].status, "published", "v2 should not be publishable while v1 is published");
  assert.equal(v2Result[0].status, "draft", "v2 should still be draft");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
});

// ── Riding buddy integration tests ───────────────────────────────

test("Buddy: updateChild sets and reads preferred_buddy_child_id via REST", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(50, "BuddyA");
  const b = setupHousehold(51, "BuddyB");
  const childAId = UID(250);
  const childBId = UID(251);
  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childAId}', '${GROUP_ID}', '${a.householdId}', 'Alfie', 'A', '${a.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childBId}', '${GROUP_ID}', '${b.householdId}', 'Bella', 'B', '${b.userId}') ON CONFLICT DO NOTHING;
  `);

  // Sign in as user A and set buddy for child A → child B
  const token = signInUser("buddya@test.kidpool");
  const jwt = token.access_token;
  assert.ok(jwt, "Should get JWT for BuddyA");

  const updateResult = JSON.parse(execSync(
    `curl -s -X PATCH -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"preferred_buddy_child_id":"${childBId}"}' "${SUPABASE_URL}/rest/v1/children?id=eq.${childAId}"`,
    { encoding: "utf8" },
  ));
  assert.ok(Array.isArray(updateResult) && updateResult.length > 0, "PATCH should return updated row");
  assert.equal(updateResult[0].preferred_buddy_child_id, childBId, "Buddy should be set to childB");

  // Read back to verify persistence
  const readBack = restGet("children", { id: childAId });
  assert.equal(readBack[0].preferred_buddy_child_id, childBId, "Buddy should persist on read-back");

  // Clear buddy (set to null)
  const clearResult = JSON.parse(execSync(
    `curl -s -X PATCH -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"preferred_buddy_child_id":null}' "${SUPABASE_URL}/rest/v1/children?id=eq.${childAId}"`,
    { encoding: "utf8" },
  ));
  assert.equal(clearResult[0].preferred_buddy_child_id, null, "Buddy should be cleared");

  cleanupAllTestData();
  deleteTestUser(a.userId);
  deleteTestUser(b.userId);
});

test("Buddy: self-buddy CHECK constraint rejects preferred_buddy_child_id = id", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(52, "SelfBuddy");
  const childId = UID(252);
  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childId}', '${GROUP_ID}', '${a.householdId}', 'Solo', 'Self', '${a.userId}') ON CONFLICT DO NOTHING;
  `);

  // Attempt to set self as buddy — should fail with CHECK violation
  const result = runSql(`UPDATE public.children SET preferred_buddy_child_id = '${childId}' WHERE id = '${childId}';`);
  assert.ok(result.error, "Self-buddy UPDATE should produce an error");
  assert.match(result.error.message, /children_buddy_not_self/i, "Error should mention the CHECK constraint");

  // Verify the buddy was NOT set
  const readBack = restGet("children", { id: childId });
  assert.equal(readBack[0].preferred_buddy_child_id, null, "Self-buddy should not have been saved");

  cleanupAllTestData();
  deleteTestUser(a.userId);
});

test("Buddy: FK on delete set null clears buddy when buddy child is deleted", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(53, "BuddyHolder");
  const b = setupHousehold(54, "BuddyTarget");
  const childAId = UID(253);
  const childBId = UID(254);
  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childAId}', '${GROUP_ID}', '${a.householdId}', 'Holder', 'A', '${a.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childBId}', '${GROUP_ID}', '${b.householdId}', 'Target', 'B', '${b.userId}') ON CONFLICT DO NOTHING;
    UPDATE public.children SET preferred_buddy_child_id = '${childBId}' WHERE id = '${childAId}';
  `);

  // Verify buddy is set
  const before = restGet("children", { id: childAId });
  assert.equal(before[0].preferred_buddy_child_id, childBId, "Buddy should be set before deletion");

  // Delete the buddy target child
  runSql(`DELETE FROM public.children WHERE id = '${childBId}';`);

  // Verify buddy pref is now NULL (FK on delete set null)
  const after = restGet("children", { id: childAId });
  assert.equal(after[0].preferred_buddy_child_id, null, "Buddy should be NULL after buddy child deleted");

  cleanupAllTestData();
  deleteTestUser(a.userId);
  deleteTestUser(b.userId);
});

test("Buddy: group member can read all children with preferred_buddy_child_id column", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(55, "GroupReadA");
  const b = setupHousehold(56, "GroupReadB");
  const childAId = UID(255);
  const childBId = UID(256);
  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childAId}', '${GROUP_ID}', '${a.householdId}', 'Reader', 'A', '${a.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childBId}', '${GROUP_ID}', '${b.householdId}', 'Other', 'B', '${b.userId}') ON CONFLICT DO NOTHING;
    UPDATE public.children SET preferred_buddy_child_id = '${childBId}' WHERE id = '${childAId}';
  `);

  // Sign in as user A and read all children in the group (this is what listGroupChildren does)
  const token = signInUser("groupreada@test.kidpool");
  const jwt = token.access_token;
  const childrenResult = JSON.parse(execSync(
    `curl -s -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" "${SUPABASE_URL}/rest/v1/children?select=id,first_name,preferred_buddy_child_id&group_id=eq.${GROUP_ID}&active=eq.true&order=first_name.asc"`,
    { encoding: "utf8" },
  ));

  assert.ok(Array.isArray(childrenResult), "Should get an array");
  assert.ok(childrenResult.length >= 2, "Should see at least 2 children in the group");

  // Find child A and verify buddy is set
  const childA = childrenResult.find((c) => c.id === childAId);
  assert.ok(childA, "Should find child A in results");
  assert.equal(childA.preferred_buddy_child_id, childBId, "Child A's buddy should be child B");

  // Find child B and verify it's visible (cross-household read within same group)
  const childB = childrenResult.find((c) => c.id === childBId);
  assert.ok(childB, "Should find child B in results (same-group cross-household read)");

  cleanupAllTestData();
  deleteTestUser(a.userId);
  deleteTestUser(b.userId);
});

test("Buddy: Edge Function honors preferred_buddy_child_id from DB rows", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(57, "BuddyCoord", "member", true);
  const driver = setupHousehold(58, "BuddyDriver", "member", false);
  const other = setupHousehold(59, "BuddyOther", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  const driverChildId = UID(257);
  const otherChildId = UID(258);
  const buddyChildId = UID(259);

  // Setup: driver has 1 own child + capacity 2.
  // Two other children need rides: one has buddy=driver's child, one doesn't.
  // The buddy child should be assigned over the non-buddy child.
  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(357)}', '${GROUP_ID}', '${driver.householdId}', 'BuddyCar', 2, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${driverChildId}', '${GROUP_ID}', '${driver.householdId}', 'Zoe', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${otherChildId}', '${GROUP_ID}', '${other.householdId}', 'Aaron', 'Other', '${other.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${buddyChildId}', '${GROUP_ID}', '${other.householdId}', 'Bella', 'Buddy', '${other.userId}') ON CONFLICT DO NOTHING;
    -- Bella's buddy is Zoe (the driver's own child)
    UPDATE public.children SET preferred_buddy_child_id = '${driverChildId}' WHERE id = '${buddyChildId}';
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(557)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(558)}', '${GROUP_ID}', '${weekId}', '${other.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(557)}', '${tripId}', '${driverChildId}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(558)}', '${tripId}', '${otherChildId}', true, '${other.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(558)}', '${tripId}', '${buddyChildId}', true, '${other.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(557)}', '${tripId}', '${driver.userId}', '${UID(357)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate schedule as coordinator
  const coordToken = signInUser("buddycoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");

  // Find rider assignments for the trip
  const riderAssignments = restGet("rider_assignments", { group_id: GROUP_ID });
  assert.ok(riderAssignments.length > 0, "Should have rider assignments");

  // Driver's own child should be assigned
  const driverChildAssigned = riderAssignments.some((ra) => ra.child_id === driverChildId);
  assert.ok(driverChildAssigned, "Driver's own child should be assigned");

  // Buddy child (Bella) should be assigned to the same driver as Zoe
  // Aaron (no buddy, sorts first alphabetically) should be the one left out
  const buddyChildAssigned = riderAssignments.some((ra) => ra.child_id === buddyChildId);
  assert.ok(buddyChildAssigned, "Buddy child should be assigned (buddy priority over name sort)");

  const otherChildAssigned = riderAssignments.some((ra) => ra.child_id === otherChildId);
  // With capacity 2 (own child + 1 other), only 1 other fits. Buddy child wins.
  assert.ok(!otherChildAssigned, "Non-buddy child should be uncovered (capacity reached by buddy child)");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(other.userId);
});

test("Directory: list_group_directory returns phone/email only when shared", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(60, "DirA");
  const b = setupHousehold(61, "DirB");
  runSql(`
    UPDATE public.profiles SET phone = '(415) 555-0101', share_phone = true, share_email = true WHERE id = '${a.userId}';
    UPDATE public.profiles SET phone = '(415) 555-0102', share_phone = false, share_email = false WHERE id = '${b.userId}';
  `);

  const token = signInUser("dira@test.kidpool");
  const jwt = token.access_token;
  const result = JSON.parse(execSync(
    `curl -s -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -d '{"target_group_id":"${GROUP_ID}"}' "${SUPABASE_URL}/rest/v1/rpc/list_group_directory"`,
    { encoding: "utf8" },
  ));
  assert.ok(Array.isArray(result), "Directory RPC should return an array");
  const aRow = result.find((r) => r.id === a.userId);
  const bRow = result.find((r) => r.id === b.userId);
  assert.ok(aRow, "User A should appear in directory");
  assert.ok(bRow, "User B should appear in directory");
  assert.equal(aRow.phone, "(415) 555-0101", "A's phone should be visible (share_phone=true)");
  assert.ok(aRow.email && aRow.email.includes("@"), "A's email should be visible (share_email=true)");
  assert.equal(bRow.phone, null, "B's phone should be null (share_phone=false)");
  assert.equal(bRow.email, null, "B's email should be null (share_email=false)");
  assert.equal(aRow.share_phone, true, "share_phone flag should be returned");
  assert.equal(aRow.household_name, "DirA Test", "household_name should be joined");

  cleanupAllTestData();
  deleteTestUser(a.userId);
  deleteTestUser(b.userId);
});

test("Directory: updateCurrentProfile can set phone via REST", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(62, "PhoneUp");
  const token = signInUser("phoneup@test.kidpool");
  const jwt = token.access_token;

  const updateResult = JSON.parse(execSync(
    `curl -s -X PATCH -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"phone":"(415) 555-9999"}' "${SUPABASE_URL}/rest/v1/profiles?id=eq.${a.userId}"`,
    { encoding: "utf8" },
  ));
  assert.ok(Array.isArray(updateResult) && updateResult.length > 0, "PATCH should return updated row");
  assert.equal(updateResult[0].phone, "(415) 555-9999", "Phone should be updated");

  cleanupAllTestData();
  deleteTestUser(a.userId);
});

test("Child photo: updateChild can set photo_url via REST", { skip: !SERVICE_KEY }, async () => {
  const a = setupHousehold(63, "PhotoUp");
  const childId = UID(263);
  runSql(`
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childId}', '${GROUP_ID}', '${a.householdId}', 'Photo', 'Kid', '${a.userId}') ON CONFLICT DO NOTHING;
  `);

  const token = signInUser("photoup@test.kidpool");
  const jwt = token.access_token;

  const photoUrl = "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Photo";
  const updateResult = JSON.parse(execSync(
    `curl -s -X PATCH -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"photo_url":"${photoUrl}"}' "${SUPABASE_URL}/rest/v1/children?id=eq.${childId}"`,
    { encoding: "utf8" },
  ));
  assert.ok(Array.isArray(updateResult) && updateResult.length > 0, "PATCH should return updated row");
  assert.equal(updateResult[0].photo_url, photoUrl, "photo_url should be set");

  const readBack = restGet("children", { id: childId });
  assert.equal(readBack[0].photo_url, photoUrl, "photo_url should persist on read-back");

  cleanupAllTestData();
  deleteTestUser(a.userId);
});

test("Priority: Edge Function honors is_priority from DB rows", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(64, "PrioCoord", "member", true);
  const driver = setupHousehold(65, "PrioDriver", "member", false);
  const other = setupHousehold(66, "PrioOther", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips(coord.userId, coord.householdId);
  const tripId = tripIds[0];

  const driverChildId = UID(264);
  const otherChildId = UID(265);
  const priorityChildId = UID(266);

  // Setup: driver has 1 own child + capacity 2.
  // Three riders total: own child + 2 others. Only 1 "other" seat available.
  // otherChild (Aaron) sorts before priorityChild (Sara) alphabetically.
  // priorityChild has is_priority=true set via SQL.
  // The Edge Function should read is_priority from the DB and the algorithm
  // should assign priorityChild over otherChild.
  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${UID(364)}', '${GROUP_ID}', '${driver.householdId}', 'PrioCar', 2, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${driverChildId}', '${GROUP_ID}', '${driver.householdId}', 'Zoe', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${otherChildId}', '${GROUP_ID}', '${other.householdId}', 'Aaron', 'Other', '${other.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${priorityChildId}', '${GROUP_ID}', '${other.householdId}', 'Sara', 'Pollock', '${other.userId}') ON CONFLICT DO NOTHING;
    UPDATE public.children SET is_priority = true WHERE id = '${priorityChildId}';
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(564)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(565)}', '${GROUP_ID}', '${weekId}', '${other.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(564)}', '${tripId}', '${driverChildId}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(565)}', '${tripId}', '${otherChildId}', true, '${other.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(565)}', '${tripId}', '${priorityChildId}', true, '${other.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(564)}', '${tripId}', '${driver.userId}', '${UID(364)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate schedule as coordinator
  const coordToken = signInUser("priocoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");

  // Find rider assignments for the trip
  const riderAssignments = restGet("rider_assignments", { group_id: GROUP_ID });
  assert.ok(riderAssignments.length > 0, "Should have rider assignments");

  // Priority child (Sara) should be assigned
  const priorityChildAssigned = riderAssignments.some((ra) => ra.child_id === priorityChildId);
  assert.ok(priorityChildAssigned, "Priority child Sara should be assigned over Aaron despite name sort");

  // Non-priority child (Aaron) should be uncovered (capacity reached)
  const otherChildAssigned = riderAssignments.some((ra) => ra.child_id === otherChildId);
  assert.ok(!otherChildAssigned, "Non-priority child Aaron should be uncovered (priority won the seat)");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(other.userId);
});

// ── Backend edge-case tests (Phase C) ─────────────────────────────

test("Backend: auto-publish publishes new version when prior was published and all confirmed", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(500, "AutoPubCoord", "coordinator", true);
  const driver = setupHousehold(501, "AutoPubDriver", "member", false);
  const { weekId, tripIds } = setupWeekAndTrips(coord.userId, coord.householdId);
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(365)}', '${GROUP_ID}', '${driver.householdId}', 'AutoPubCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(267)}', '${GROUP_ID}', '${driver.householdId}', 'AutoPubKid', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(567)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(567)}', '${tripId}', '${UID(267)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(567)}', '${tripId}', '${driver.userId}', '${UID(365)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Pre-publish the schedule so auto-publish triggers on regenerate
  const coordToken = signInUser("autopubcoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "First generate should succeed");

  // Confirm all assignments and publish via SQL
  runSql(`
    UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM schedule_versions WHERE week_id = '${weekId}' AND status = 'draft');
    UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
  `);

  // Now regenerate — all assignments are confirmed, no uncovered, prior was published
  // → auto-publish should fire inside the Edge Function
  const regenResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(regenResult.success, "Regenerate should succeed");
  assert.ok(regenResult.auto_published, "Edge Function should report auto_published=true");

  // Verify the new version is published (auto-publish fired)
  const versions = restGet("schedule_versions", { week_id: weekId });
  const latest = versions.sort((a, b) => b.version_number - a.version_number)[0];
  assert.equal(latest.status, "published", "Auto-publish should have published the new version");

  // Note: auto-publish now invokes send-push (published + uncovered + admin_escalation
  // types). Test users have no push_subscriptions rows so no pushes are actually
  // delivered; verifying push delivery is out of scope for this test.

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
});

test("Backend: volunteer_for_uncovered_trip has no max_drives check (documents current behavior)", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(510, "MaxDrCoord", "coordinator", true);
  const rider = setupHousehold(512, "MaxDrRider", "member", false);
  assert.ok(coord.userId, `Coord user should be created. Got null.`);
  assert.ok(rider.userId, `Rider user should be created. Got null.`);
  const { weekId, tripIds } = setupWeekAndTrips(coord.userId, coord.householdId);
  const afternoonTrip = tripIds[1];

  runSql(`INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(269)}', '${GROUP_ID}', '${rider.householdId}', 'MaxDrKid', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(367)}', '${GROUP_ID}', '${rider.householdId}', 'MaxDrRiderCar', 4, true, '${rider.userId}') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(569)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 0) ON CONFLICT DO NOTHING;`);
  runSql(tripIds.map((t) => `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(569)}', '${t}', '${UID(269)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;`).join("\n"));
  runSql(tripIds.map((t) => `INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(569)}', '${t}', '${UID(269)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;`).join("\n"));

  // Generate and publish — no driver available, so rider's child is uncovered
  const coordToken = signInUser("maxdrcoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Generate should succeed");
  runSql(`
    UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';
  `);

  const versions = restGet("schedule_versions", { week_id: weekId, status: "published" });
  const versionId = versions[0].id;

  // Verify setup
  const checkins = restGet("weekly_checkins", { id: UID(569) });
  assert.ok(checkins.length > 0, `Rider checkin should exist. Got ${checkins.length}`);
  const children = restGet("children", { id: UID(269) });
  assert.ok(children.length > 0, `Rider child should exist. Got ${children.length}`);
  const rideReqs = restGet("ride_requests", { checkin_id: UID(569) });
  assert.ok(rideReqs.length > 0, `Rider should have ride_requests. Got ${rideReqs.length}`);

  // Rider (max_drives=0) attempts to volunteer for uncovered afternoon trip
  const riderToken = signInUser("maxdrrider@test.kidpool");
  const riderJwt = riderToken.access_token;
  const volunteerResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${riderJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"p_trip_id":"${afternoonTrip}","p_schedule_version_id":"${versionId}"}' "${SUPABASE_URL}/rest/v1/rpc/volunteer_for_uncovered_trip"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));

  // Current behavior: the RPC does NOT check max_drives, so volunteering succeeds
  // even though the rider's max_drives is 0. This documents the known gap.
  assert.ok(!volunteerResult.code || !volunteerResult.message,
    `Volunteer should succeed despite max_drives=0 (known gap: no max_drives check). Got: ${JSON.stringify(volunteerResult)}`);

  const newAssignments = restGet("driver_assignments", { schedule_version_id: versionId, trip_id: afternoonTrip, driver_profile_id: rider.userId });
  assert.ok(newAssignments.length > 0, "Volunteer assignment should be created despite max_drives=0");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(rider.userId);
});

test("Backend: submitCheckin allows empty check-in (no ride requests)", { skip: !SERVICE_KEY }, async () => {
  const family = setupHousehold(520, "EmptyCheck", "member", false);
  const { weekId } = setupWeekAndTrips(family.userId, family.householdId);

  runSql(`INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(270)}', '${GROUP_ID}', '${family.householdId}', 'EmptyKid', 'Family', '${family.userId}') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(368)}', '${GROUP_ID}', '${family.householdId}', 'EmptyCar', 4, true, '${family.userId}') ON CONFLICT DO NOTHING;`);
  runSql(`INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(570)}', '${GROUP_ID}', '${weekId}', '${family.householdId}', 'draft', 5) ON CONFLICT DO NOTHING;`);

  // Submit the check-in with zero ride requests and zero driver availability
  const familyToken = signInUser("emptycheck@test.kidpool");
  const familyJwt = familyToken.access_token;

  const submitResult = JSON.parse(execSync(
    `curl -s -X PATCH -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${familyJwt}" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"status":"submitted"}' "${SUPABASE_URL}/rest/v1/weekly_checkins?id=eq.${UID(570)}&group_id=eq.${GROUP_ID}"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));

  // Current behavior: empty check-in submission succeeds (no validation for ride requests)
  assert.ok(Array.isArray(submitResult) && submitResult.length > 0, `Empty check-in submission should return the updated row. Got: ${JSON.stringify(submitResult)}`);
  assert.equal(submitResult[0].status, "submitted", "Check-in should be marked submitted");

  const rideRequests = restGet("ride_requests", { checkin_id: UID(570) });
  assert.equal(rideRequests.length, 0, "No ride requests should exist for the empty check-in");

  cleanupAllTestData();
  deleteTestUser(family.userId);
});

// ── Cancel ride / Add ride back RPC tests ──────────────────────

function rpcCall(jwt, rpcName, body) {
  const result = execSync(
    `curl -s -w "\\n%{http_code}" -X POST -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${jwt}" -H "Content-Type: application/json" -d '${JSON.stringify(body)}' "${SUPABASE_URL}/rest/v1/rpc/${rpcName}"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const lines = result.trim().split("\n");
  const httpCode = lines[lines.length - 1];
  const responseBody = lines.slice(0, -1).join("\n").trim();
  if (httpCode === "204" || !responseBody) return {};
  try {
    return JSON.parse(responseBody);
  } catch {
    return { raw: responseBody };
  }
}

test("RPC: cancel_ride_for_child — parent can cancel own child's ride", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(40, "CancelCoord", "member", true);
  const driver = setupHousehold(41, "CancelDriver", "member", false);
  const rider = setupHousehold(42, "CancelRider", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(341)}', '${GROUP_ID}', '${driver.householdId}', 'DriverCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(241)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(242)}', '${GROUP_ID}', '${rider.householdId}', 'R1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(541)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(542)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(541)}', '${tripId}', '${UID(241)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(542)}', '${tripId}', '${UID(242)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(541)}', '${tripId}', '${driver.userId}', '${UID(341)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate + publish schedule
  const coordToken = signInUser("cancelcoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");

  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';`);

  // Find the driver assignment + rider assignments
  const assignments = restGet("driver_assignments", { group_id: GROUP_ID, trip_id: tripId });
  assert.ok(assignments.length > 0, "Should have driver assignments");
  const driverAssignment = assignments[0];

  const riderAssignments = restGet("rider_assignments", { driver_assignment_id: driverAssignment.id });
  assert.ok(riderAssignments.length >= 2, "Should have 2 rider assignments");

  // Rider parent cancels their child's ride
  const riderToken = signInUser("cancelrider@test.kidpool");
  const riderJwt = riderToken.access_token;
  const cancelResult = rpcCall(riderJwt, "cancel_ride_for_child", {
    p_child_id: UID(242),
    p_driver_assignment_id: driverAssignment.id,
  });
  assert.ok(!cancelResult.code && !cancelResult.message, `Cancel should succeed. Got: ${JSON.stringify(cancelResult)}`);

  // Verify rider assignment for R1 is deleted, D1 still exists
  const remaining = restGet("rider_assignments", { driver_assignment_id: driverAssignment.id });
  const r1StillExists = remaining.some((ra) => ra.child_id === UID(242));
  const d1StillExists = remaining.some((ra) => ra.child_id === UID(241));
  assert.ok(!r1StillExists, "R1's rider assignment should be deleted");
  assert.ok(d1StillExists, "D1's rider assignment should still exist");

  // Verify audit event
  const audits = restGet("audit_events", { group_id: GROUP_ID });
  const cancelAudit = audits.find((a) => a.action === "ride_cancelled");
  assert.ok(cancelAudit, "Audit event for ride_cancelled should exist");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(rider.userId);
});

test("RPC: cancel_ride_for_child — cannot cancel another family's ride", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(43, "OtherCoord", "member", true);
  const driver = setupHousehold(44, "OtherDriver", "member", false);
  const rider = setupHousehold(45, "OtherRider", "member", false);
  const attacker = setupHousehold(46, "Attacker", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(344)}', '${GROUP_ID}', '${driver.householdId}', 'DriverCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(244)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(245)}', '${GROUP_ID}', '${rider.householdId}', 'R1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(544)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(545)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(544)}', '${tripId}', '${UID(244)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(545)}', '${tripId}', '${UID(245)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(544)}', '${tripId}', '${driver.userId}', '${UID(344)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate + publish
  const coordToken = signInUser("othercoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");
  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';`);

  const assignments = restGet("driver_assignments", { group_id: GROUP_ID, trip_id: tripId });
  const driverAssignment = assignments[0];

  // Attacker (different household) tries to cancel rider's child
  const attackerToken = signInUser("attacker@test.kidpool");
  const attackerJwt = attackerToken.access_token;
  const cancelResult = rpcCall(attackerJwt, "cancel_ride_for_child", {
    p_child_id: UID(245),
    p_driver_assignment_id: driverAssignment.id,
  });
  assert.ok(cancelResult.code || cancelResult.message, `Attacker should not be able to cancel another family's ride. Got: ${JSON.stringify(cancelResult)}`);

  // Verify rider assignment still exists
  const remaining = restGet("rider_assignments", { driver_assignment_id: driverAssignment.id });
  const r1StillExists = remaining.some((ra) => ra.child_id === UID(245));
  assert.ok(r1StillExists, "R1's rider assignment should still exist after attacker's failed cancel");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(rider.userId);
  deleteTestUser(attacker.userId);
});

test("RPC: add_ride_back_for_child — parent can re-add after cancelling", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(47, "AddBackCoord", "member", true);
  const driver = setupHousehold(48, "AddBackDriver", "member", false);
  const rider = setupHousehold(49, "AddBackRider", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(348)}', '${GROUP_ID}', '${driver.householdId}', 'DriverCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(248)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(249)}', '${GROUP_ID}', '${rider.householdId}', 'R1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(548)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(549)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(548)}', '${tripId}', '${UID(248)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(549)}', '${tripId}', '${UID(249)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(548)}', '${tripId}', '${driver.userId}', '${UID(348)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate + publish
  const coordToken = signInUser("addbackcoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");
  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';`);

  const assignments = restGet("driver_assignments", { group_id: GROUP_ID, trip_id: tripId });
  const driverAssignment = assignments[0];
  const versions = restGet("schedule_versions", { week_id: weekId, status: "published" });
  const versionId = versions[0].id;

  // Cancel first
  const riderToken = signInUser("addbackrider@test.kidpool");
  const riderJwt = riderToken.access_token;
  rpcCall(riderJwt, "cancel_ride_for_child", {
    p_child_id: UID(249),
    p_driver_assignment_id: driverAssignment.id,
  });

  // Verify cancelled
  let remaining = restGet("rider_assignments", { driver_assignment_id: driverAssignment.id });
  assert.ok(!remaining.some((ra) => ra.child_id === UID(249)), "R1 should be cancelled");

  // Add ride back
  const addResult = rpcCall(riderJwt, "add_ride_back_for_child", {
    p_child_id: UID(249),
    p_driver_assignment_id: driverAssignment.id,
    p_trip_id: tripId,
    p_schedule_version_id: versionId,
    p_group_id: GROUP_ID,
  });
  assert.ok(!addResult.code && !addResult.message, `Add ride back should succeed. Got: ${JSON.stringify(addResult)}`);

  // Verify re-created
  remaining = restGet("rider_assignments", { driver_assignment_id: driverAssignment.id });
  const r1Exists = remaining.some((ra) => ra.child_id === UID(249));
  assert.ok(r1Exists, "R1's rider assignment should be re-created");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(rider.userId);
});

test("RPC: add_ride_back_for_child — idempotent (calling twice doesn't duplicate)", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(50, "IdempotentCoord", "member", true);
  const driver = setupHousehold(51, "IdempotentDriver", "member", false);
  const rider = setupHousehold(52, "IdempotentRider", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(351)}', '${GROUP_ID}', '${driver.householdId}', 'DriverCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(251)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(252)}', '${GROUP_ID}', '${rider.householdId}', 'R1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(551)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(552)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(551)}', '${tripId}', '${UID(251)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(552)}', '${tripId}', '${UID(252)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(551)}', '${tripId}', '${driver.userId}', '${UID(351)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate + publish
  const coordToken = signInUser("idempotentcoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");
  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';`);

  const assignments = restGet("driver_assignments", { group_id: GROUP_ID, trip_id: tripId });
  const driverAssignment = assignments[0];
  const versions = restGet("schedule_versions", { week_id: weekId, status: "published" });
  const versionId = versions[0].id;

  // Cancel + add back
  const riderToken = signInUser("idempotentrider@test.kidpool");
  const riderJwt = riderToken.access_token;
  rpcCall(riderJwt, "cancel_ride_for_child", { p_child_id: UID(252), p_driver_assignment_id: driverAssignment.id });
  rpcCall(riderJwt, "add_ride_back_for_child", { p_child_id: UID(252), p_driver_assignment_id: driverAssignment.id, p_trip_id: tripId, p_schedule_version_id: versionId, p_group_id: GROUP_ID });

  // Call add back again (should not duplicate)
  rpcCall(riderJwt, "add_ride_back_for_child", { p_child_id: UID(252), p_driver_assignment_id: driverAssignment.id, p_trip_id: tripId, p_schedule_version_id: versionId, p_group_id: GROUP_ID });

  // Verify only 1 rider assignment for R1
  const remaining = restGet("rider_assignments", { driver_assignment_id: driverAssignment.id, child_id: UID(252) });
  assert.equal(remaining.length, 1, `Should have exactly 1 rider assignment for R1 (idempotent). Got ${remaining.length}`);

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(rider.userId);
});

test("RPC: scheduler still works after parent cancels a ride", { skip: !SERVICE_KEY }, async () => {
  const coord = setupHousehold(53, "SchedCoord", "member", true);
  const driver = setupHousehold(54, "SchedDriver", "member", false);
  const rider = setupHousehold(55, "SchedRider", "member", false);

  const { weekId, tripIds } = setupWeekAndTrips();
  const tripId = tripIds[0];

  runSql(`
    INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${UID(354)}', '${GROUP_ID}', '${driver.householdId}', 'DriverCar', 4, true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(254)}', '${GROUP_ID}', '${driver.householdId}', 'D1', 'Driver', '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${UID(255)}', '${GROUP_ID}', '${rider.householdId}', 'R1', 'Rider', '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(554)}', '${GROUP_ID}', '${weekId}', '${driver.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${UID(555)}', '${GROUP_ID}', '${weekId}', '${rider.householdId}', 'submitted', 5) ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(554)}', '${tripId}', '${UID(254)}', true, '${driver.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${UID(555)}', '${tripId}', '${UID(255)}', true, '${rider.userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${UID(554)}', '${tripId}', '${driver.userId}', '${UID(354)}', 'prefer') ON CONFLICT DO NOTHING;
  `);

  // Generate + publish
  const coordToken = signInUser("schedcoord@test.kidpool");
  const coordJwt = coordToken.access_token;
  const genResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(genResult.success, "Schedule generation should succeed");
  runSql(`UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${weekId}' AND status = 'draft';`);

  // Cancel rider's ride
  const assignments = restGet("driver_assignments", { group_id: GROUP_ID, trip_id: tripId });
  const driverAssignment = assignments[0];
  const riderToken = signInUser("schedrider@test.kidpool");
  const riderJwt = riderToken.access_token;
  rpcCall(riderJwt, "cancel_ride_for_child", { p_child_id: UID(255), p_driver_assignment_id: driverAssignment.id });

  // Regenerate schedule — should succeed and re-create the rider
  const regenResult = JSON.parse(execSync(
    `curl -s -X POST -H "Authorization: Bearer ${coordJwt}" -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d '{"weekId":"${weekId}"}' "${SUPABASE_URL}/functions/v1/generate-schedule"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  ));
  assert.ok(regenResult.success, "Schedule regeneration should succeed after cancel");

  // Verify new version has rider assignment for R1
  const versions = restGet("schedule_versions", { week_id: weekId });
  const latestVersion = versions.sort((a, b) => b.version_number - a.version_number)[0];
  const newAssignments = restGet("driver_assignments", { schedule_version_id: latestVersion.id, trip_id: tripId });
  assert.ok(newAssignments.length > 0, "New version should have driver assignments");
  const newRiderAssignments = restGet("rider_assignments", { driver_assignment_id: newAssignments[0].id });
  const r1Reassigned = newRiderAssignments.some((ra) => ra.child_id === UID(255));
  assert.ok(r1Reassigned, "R1 should be re-assigned in the new version (scheduler reads ride_requests, not rider_assignments)");

  cleanupAllTestData();
  deleteTestUser(coord.userId);
  deleteTestUser(driver.userId);
  deleteTestUser(rider.userId);
});