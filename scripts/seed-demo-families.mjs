#!/usr/bin/env node
// Seed 6 demo families into the pilot group for the upcoming week.
//
// Usage: npm run seed-demo
// Targets the STAGING project by default (jfyjgmhqnlbdcafoarrg).
// Override with SUPABASE_PROJECT_REF env var (aborts if set to production).
// Requires: Supabase CLI linked to the target project (npm run link:test).

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const GROUP_ID = "c1000000-0000-4000-8000-000000000001";

if (PROJECT_REF === PRODUCTION_REF) {
  console.error("Aborting: seed-demo must not run against production. Run `npm run link:test` first.");
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

const FAMILIES = [
  { name: "Chen",    first: "Wei",   email: "chen@seed.kidpool",    kids: [["Lily","Chen"],["Max","Chen"]],     vehicle: "Silver Honda",  seats: 4, maxDrives: 3 },
  { name: "Garcia",  first: "Maria", email: "garcia@seed.kidpool",   kids: [["Sofia","Garcia"]],                vehicle: "Red Toyota",    seats: 3, maxDrives: 3 },
  { name: "Johnson", first: "Sarah", email: "johnson@seed.kidpool", kids: [["Emma","Johnson"],["Jack","Johnson"]], vehicle: "Blue Subaru", seats: 5, maxDrives: 5 },
  { name: "Patel",   first: "Priya", email: "patel@seed.kidpool",    kids: [["Aria","Patel"]],                  vehicle: null,           seats: 0, maxDrives: 0 },
  { name: "Williams",first: "David", email: "williams@seed.kidpool", kids: [["Mason","Williams"],["Ava","Williams"],["Leo","Williams"]], vehicle: "Green Volvo", seats: 4, maxDrives: 3 },
  { name: "OBrien",  first: "Sean",  email: "obrien@seed.kidpool",   kids: [["Finn","OBrien"],["Maeve","OBrien"]], vehicle: "White Mazda",  seats: 3, maxDrives: 3 },
  { name: "Anderson",first: "Lisa", email: "anderson@seed.kidpool",  kids: [["Ivy","Anderson"],["Theo","Anderson"],["Nora","Anderson"],["Sam","Anderson"]], vehicle: "Navy Prius", seats: 3, maxDrives: 2 },
  { name: "Thompson",first: "Mark", email: "thompson@seed.kidpool",  kids: [["Olive","Thompson"]],              vehicle: "Gray Odyssey",  seats: 7, maxDrives: 1 },
  { name: "Martinez",first: "Elena", email: "martinez@seed.kidpool", kids: [["Carlos","Martinez"],["Isabel","Martinez"]], vehicle: null, seats: 0, maxDrives: 0 },
  { name: "Lee",     first: "James", email: "lee@seed.kidpool",      kids: [["Maya","Lee"]],                    vehicle: "Black Tesla",   seats: 5, maxDrives: 0 },
];

// Driver availability per family (day index 1-5 = Mon-Fri, direction morning/afternoon)
const DRIVER_AVAIL = {
  Chen:     [{d:1,dir:"morning",pref:"prefer"},{d:2,dir:"morning",pref:"can"},{d:3,dir:"morning",pref:"prefer"},{d:4,dir:"morning",pref:"can"},{d:5,dir:"morning",pref:"prefer"}],
  Garcia:   [{d:2,dir:"afternoon",pref:"prefer"},{d:4,dir:"afternoon",pref:"prefer"},{d:1,dir:"afternoon",pref:"can"},{d:3,dir:"afternoon",pref:"can"},{d:5,dir:"afternoon",pref:"can"}],
  Johnson:  [{d:1,dir:"morning",pref:"prefer"},{d:2,dir:"morning",pref:"prefer"},{d:3,dir:"morning",pref:"prefer"},{d:4,dir:"morning",pref:"prefer"},{d:5,dir:"morning",pref:"prefer"}],
  Patel:    [],
  Williams: [{d:3,dir:"morning",pref:"prefer"},{d:4,dir:"morning",pref:"prefer"},{d:1,dir:"afternoon",pref:"can"},{d:5,dir:"afternoon",pref:"can"}],
  OBrien:   [{d:2,dir:"afternoon",pref:"prefer"},{d:5,dir:"afternoon",pref:"prefer"},{d:1,dir:"afternoon",pref:"can"},{d:3,dir:"afternoon",pref:"can"}],
  Anderson: [{d:1,dir:"morning",pref:"can"},{d:3,dir:"morning",pref:"can"}],
  Thompson: [{d:4,dir:"afternoon",pref:"prefer"}],
  Martinez: [],
  Lee:      [],
};

// ── Service key resolution ────────────────────────────────────────
function getServiceKey() {
  if (process.env.SUPABASE_TEST_SERVICE_KEY) return process.env.SUPABASE_TEST_SERVICE_KEY;
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const result = execSync(`curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`, { encoding: "utf8" });
    const parsed = JSON.parse(result);
    const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
    for (const k of keyList) { if (k.id === "service_role") return k.api_key; }
  } catch {}
  return null;
}

const SERVICE_KEY = getServiceKey();
if (!SERVICE_KEY) { console.error("Could not resolve Supabase service key."); process.exit(1); }

// ── Helpers ──────────────────────────────────────────────────────
function runSql(sql) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-seed-"));
  const file = path.join(tmpDir, "query.sql");
  writeFileSync(file, sql);
  try {
    const result = execSync(`supabase db query --linked -f "${file}" 2>/dev/null`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(result);
  } catch (e) {
    const parsed = JSON.parse(e.stdout || '{"rows":[]}');
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed;
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

function createAuthUser(email, fullName) {
  // Clean up stale user first
  try {
    const list = execSync(`curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users?per_page=1000"`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(list);
    const users = parsed.users || parsed || [];
    for (const u of users) {
      if (u.email === email) {
        execSync(`curl -s -X DELETE -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users/${u.id}" > /dev/null`, { encoding: "utf8" });
      }
    }
  } catch {}

  const body = JSON.stringify({ email, password: "SeedPass123!", email_confirm: true, user_metadata: { full_name: fullName } });
  const result = execSync(`curl -s -X POST -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '${body}' "${SUPABASE_URL}/auth/v1/admin/users"`, { encoding: "utf8" });
  const parsed = JSON.parse(result);
  return parsed.id;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("\n  seed-demo-families\n");

  // 1. Find the upcoming week (Aug 3, 2026)
  const weekResult = runSql(`SELECT id, starts_on FROM public.weeks WHERE starts_on > to_char(now(), 'YYYY-MM-DD')::date ORDER BY starts_on ASC LIMIT 1;`);
  const weekId = weekResult.rows[0]?.id;
  const weekStartsOn = weekResult.rows[0]?.starts_on;
  if (!weekId) { console.error("  No upcoming week found."); process.exit(1); }
  console.log(`  Week: ${weekStartsOn} (${weekId})`);

  // 2. Get trip IDs
  const tripResult = runSql(`SELECT id, service_date, direction FROM public.trips WHERE week_id = '${weekId}' ORDER BY service_date, direction;`);
  const trips = tripResult.rows;
  const tripByDayDir = new Map();
  for (const t of trips) {
    const day = new Date(t.service_date + "T00:00:00").getDay();
    tripByDayDir.set(`${day}:${t.direction}`, t.id);
  }

  // 3. Create auth users + collect IDs
  const familyData = [];
  for (const fam of FAMILIES) {
    console.log(`  Creating auth user: ${fam.email}`);
    const userId = createAuthUser(fam.email, `${fam.first} ${fam.name}`);
    if (!userId) { console.error(`  Failed to create user for ${fam.email}`); process.exit(1); }
    familyData.push({ ...fam, userId });
  }

  // 4. Update profiles with proper full_name + build SQL
  console.log("\n  Inserting household data...");

  const profileUpdates = familyData.map((f) =>
    `UPDATE public.profiles SET full_name = '${f.first} ${f.name}' WHERE id = '${f.userId}';`
  ).join("\n");

  const householdInserts = familyData.map((f, i) =>
    `INSERT INTO public.households (id, group_id, name, created_by) VALUES ('a2000000-0000-4000-8000-${String(i+1).padStart(12,"0")}', '${GROUP_ID}', '${f.name} Family', '${f.userId}') ON CONFLICT DO NOTHING;`
  ).join("\n");

  const membershipInserts = familyData.map((f, i) =>
    `INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', 'a2000000-0000-4000-8000-${String(i+1).padStart(12,"0")}', '${f.userId}', 'member', 'active') ON CONFLICT DO NOTHING;`
  ).join("\n");

  // Grant coordinator to the first family (Chen) so coordinator flows work without manual SQL.
  const coordinatorUpdate = `UPDATE public.memberships SET role = 'coordinator' WHERE profile_id = '${familyData[0].userId}' AND status = 'active';`;

  // Children
  let childCounter = 0;
  const childInserts = [];
  for (const [fi, f] of familyData.entries()) {
    for (const [first, last] of f.kids) {
      childCounter++;
      const childId = `a3000000-0000-4000-8000-${String(childCounter).padStart(12,"0")}`;
      childInserts.push(`INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${childId}', '${GROUP_ID}', 'a2000000-0000-4000-8000-${String(fi+1).padStart(12,"0")}', '${first}', '${last}', '${f.userId}') ON CONFLICT DO NOTHING;`);
    }
  }

  // Buddy pairings (3-4 demo relationships for manual QA + staging verification)
  // Child IDs: a3000000-0000-4000-8000-NNNNNNNNNNNN (counter from 1, decimal-padded)
  // 01=Lily Chen  02=Max Chen  03=Sofia Garcia  04=Emma Johnson  05=Jack Johnson
  // 06=Aria Patel  07=Mason Williams  08=Ava Williams  09=Leo Williams
  // 10=Finn OBrien  11=Maeve OBrien  12=Ivy Anderson  13=Theo Anderson
  // 14=Nora Anderson  15=Sam Anderson  16=Olive Thompson
  // 17=Carlos Martinez  18=Isabel Martinez  19=Maya Lee
  const CID = (n) => `a3000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const buddyUpdates = [
    // Bidirectional: Lily Chen ↔ Sofia Garcia
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(3)}' WHERE id = '${CID(1)}';`,
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(1)}' WHERE id = '${CID(3)}';`,
    // Bidirectional: Emma Johnson ↔ Ivy Anderson
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(12)}' WHERE id = '${CID(4)}';`,
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(4)}' WHERE id = '${CID(12)}';`,
    // One-directional: Mason Williams → Maya Lee
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(19)}' WHERE id = '${CID(7)}';`,
    // Bidirectional: Finn OBrien ↔ Olive Thompson
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(16)}' WHERE id = '${CID(10)}';`,
    `UPDATE public.children SET preferred_buddy_child_id = '${CID(10)}' WHERE id = '${CID(16)}';`,
  ];

  // Vehicles
  const vehicleInserts = [];
  for (const [fi, f] of familyData.entries()) {
    if (f.vehicle) {
      const vehicleId = `a4000000-0000-4000-8000-${String(fi+1).padStart(12,"0")}`;
      vehicleInserts.push(`INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, created_by) VALUES ('${vehicleId}', '${GROUP_ID}', 'a2000000-0000-4000-8000-${String(fi+1).padStart(12,"0")}', '${f.vehicle}', ${f.seats}, '${f.userId}') ON CONFLICT DO NOTHING;`);
    }
  }

  // Check-ins
  const checkinInserts = familyData.map((f, i) => {
    const checkinId = `a5000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`;
    return `INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives, submitted_by, submitted_at) VALUES ('${checkinId}', '${GROUP_ID}', '${weekId}', 'a2000000-0000-4000-8000-${String(i+1).padStart(12,"0")}', 'submitted', ${f.maxDrives}, '${f.userId}', now()) ON CONFLICT DO NOTHING;`;
  }).join("\n");

  // Ride requests (all kids need rides for all trips)
  const rideRequestInserts = [];
  childCounter = 0;
  for (const [fi, f] of familyData.entries()) {
    for (const [first, last] of f.kids) {
      childCounter++;
      const childId = `a3000000-0000-4000-8000-${String(childCounter).padStart(12,"0")}`;
      const checkinId = `a5000000-0000-4000-8000-${String(fi+1).padStart(12,"0")}`;
      for (const t of trips) {
        rideRequestInserts.push(`INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${checkinId}', '${t.id}', '${childId}', true, '${f.userId}') ON CONFLICT DO NOTHING;`);
      }
    }
  }

  // Driver availability
  const driverAvailInserts = [];
  for (const [fi, f] of familyData.entries()) {
    const avails = DRIVER_AVAIL[f.name] ?? DRIVER_AVAIL[f.name.replace("'","")] ?? [];
    if (avails.length === 0) continue;
    const vehicleId = `a4000000-0000-4000-8000-${String(fi+1).padStart(12,"0")}`;
    const checkinId = `a5000000-0000-4000-8000-${String(fi+1).padStart(12,"0")}`;
    for (const a of avails) {
      const tripId = tripByDayDir.get(`${a.d}:${a.dir}`);
      if (!tripId) continue;
      driverAvailInserts.push(`INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${checkinId}', '${tripId}', '${f.userId}', '${vehicleId}', '${a.pref}') ON CONFLICT DO NOTHING;`);
    }
  }

  // Run all SQL in one batch
  const allSql = [
    profileUpdates,
    householdInserts,
    membershipInserts,
    coordinatorUpdate,
    childInserts.join("\n"),
    buddyUpdates.join("\n"),
    vehicleInserts.join("\n"),
    checkinInserts,
    rideRequestInserts.join("\n"),
    driverAvailInserts.join("\n"),
  ].join("\n\n");

  try {
    runSql(allSql);
  } catch (e) {
    console.error("  SQL failed:", e.message);
    process.exit(1);
  }

  // 5. Verify
  const verify = runSql(`
    SELECT
      (SELECT count(*) FROM public.profiles WHERE email LIKE '%@seed.kidpool') AS profiles,
      (SELECT count(*) FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool')) AS households,
      (SELECT count(*) FROM public.children WHERE household_id IN (SELECT id FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool'))) AS children,
      (SELECT count(*) FROM public.children WHERE household_id IN (SELECT id FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool')) AND preferred_buddy_child_id IS NOT NULL) AS buddies,
      (SELECT count(*) FROM public.vehicles WHERE household_id IN (SELECT id FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool'))) AS vehicles,
      (SELECT count(*) FROM public.weekly_checkins WHERE household_id IN (SELECT id FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool'))) AS checkins,
      (SELECT count(*) FROM public.ride_requests WHERE checkin_id IN (SELECT id FROM public.weekly_checkins WHERE household_id IN (SELECT id FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool')))) AS ride_requests,
      (SELECT count(*) FROM public.driver_availability WHERE checkin_id IN (SELECT id FROM public.weekly_checkins WHERE household_id IN (SELECT id FROM public.households WHERE created_by IN (SELECT id FROM public.profiles WHERE email LIKE '%@seed.kidpool')))) AS driver_availability;
  `);
  const v = verify.rows[0];
  console.log("\n  Seeded data:");
  console.log(`    profiles:           ${v.profiles}`);
  console.log(`    households:         ${v.households}`);
  console.log(`    children:           ${v.children}`);
  console.log(`    buddy preferences:  ${v.buddies}`);
  console.log(`    vehicles:           ${v.vehicles}`);
  console.log(`    checkins:            ${v.checkins}`);
  console.log(`    ride_requests:      ${v.ride_requests}`);
  console.log(`    driver_availability: ${v.driver_availability}`);
  console.log("\n  Done. Sign in at https://carpool-staging.vercel.app to test.\n");
}

main().catch((e) => { console.error("\n  Error:", e.message, "\n"); process.exit(1); });