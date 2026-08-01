#!/usr/bin/env node
// Delete all 6 demo families (seed data) from the linked Supabase project.
//
// Usage: npm run delete-seed
// Targets the STAGING project by default (jfyjgmhqnlbdcafoarrg).
// Requires: Supabase CLI linked to the target project (npm run link:test).

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

if (PROJECT_REF === PRODUCTION_REF) {
  console.error("Aborting: delete-seed must not run against production. Run `npm run link:test` first.");
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

// ── Service key resolution ────────────────────────────────────────
function getServiceKey() {
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
  return null;
}

const SERVICE_KEY = getServiceKey();
if (!SERVICE_KEY) {
  console.error("Could not resolve Supabase service key.");
  console.error("Set SUPABASE_TEST_SERVICE_KEY or ensure Supabase CLI is linked.");
  process.exit(1);
}

// ── SQL helper ───────────────────────────────────────────────────
function runSql(sql) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-delseed-"));
  const file = path.join(tmpDir, "query.sql");
  writeFileSync(file, sql);
  try {
    const result = execSync(`supabase db query --linked -f "${file}" 2>/dev/null`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(result);
  } catch (e) {
    const parsed = JSON.parse(e.stdout || '{"rows":[]}');
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed;
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("\n  delete-seed: removing all @seed.kidpool demo families\n");

  // 1. Find all seed profiles
  const profiles = runSql(`SELECT id, email, full_name FROM public.profiles WHERE email LIKE '%@seed.kidpool';`);
  const profileRows = profiles.rows ?? [];
  if (profileRows.length === 0) {
    console.log("  No seed profiles found. Nothing to delete.\n");
    process.exit(0);
  }

  const profileIds = profileRows.map((p) => p.id);
  const profileIdList = profileIds.map((id) => `'${id}'`).join(",");
  console.log(`  Found ${profileRows.length} seed profiles:`);
  for (const p of profileRows) {
    console.log(`    ${p.full_name} (${p.email})`);
  }

  // 2. Find their households
  const households = runSql(`
    SELECT DISTINCT h.id, h.name
    FROM public.memberships m
    JOIN public.households h ON m.household_id = h.id
    WHERE m.profile_id IN (${profileIdList});
  `);
  const householdRows = households.rows ?? [];
  const householdIds = householdRows.map((h) => h.id);
  const householdList = householdIds.length ? householdIds.map((h) => `'${h}'`).join(",") : "NULL";

  console.log(`  Households: ${householdRows.length}`);
  for (const h of householdRows) {
    console.log(`    ${h.name} (${h.id})`);
  }

  // 3. Collect data counts
  const counts = runSql(`
    SELECT
      (SELECT count(*) FROM public.driver_confirmations WHERE driver_profile_id IN (${profileIdList})) AS driver_confirmations,
      (SELECT count(*) FROM public.driver_assignments WHERE driver_profile_id IN (${profileIdList})) AS driver_assignments,
      (SELECT count(*) FROM public.driver_availability WHERE driver_profile_id IN (${profileIdList})) AS driver_availability,
      (SELECT count(*) FROM public.weekly_checkins WHERE household_id IN (${householdList})) AS checkins,
      (SELECT count(*) FROM public.children WHERE household_id IN (${householdList})) AS children,
      (SELECT count(*) FROM public.vehicles WHERE household_id IN (${householdList})) AS vehicles,
      (SELECT count(*) FROM public.audit_events WHERE actor_profile_id IN (${profileIdList})) AS audit_events;
  `);
  const c = counts.rows[0];

  console.log("\n  Data to delete:");
  console.log(`    driver_confirmations: ${c.driver_confirmations}`);
  console.log(`    driver_assignments:   ${c.driver_assignments}`);
  console.log(`    driver_availability:  ${c.driver_availability}`);
  console.log(`    checkins:             ${c.checkins}`);
  console.log(`    children:             ${c.children}`);
  console.log(`    vehicles:             ${c.vehicles}`);
  console.log(`    audit_events:         ${c.audit_events}`);

  // 4. Delete in FK-safe order
  console.log("\n  Deleting...");
  try {
    runSql(`
      -- a. driver_confirmations
      DELETE FROM public.driver_confirmations WHERE driver_profile_id IN (${profileIdList});

      -- b. driver_assignments
      DELETE FROM public.driver_assignments
      WHERE driver_profile_id IN (${profileIdList})
         OR vehicle_id IN (SELECT id FROM public.vehicles WHERE household_id IN (${householdList}));

      -- b2. rider_assignments (RESTRICT on child_id -> children)
      DELETE FROM public.rider_assignments
      WHERE child_id IN (SELECT id FROM public.children WHERE household_id IN (${householdList}));

      -- c. driver_availability
      DELETE FROM public.driver_availability
      WHERE driver_profile_id IN (${profileIdList})
         OR vehicle_id IN (SELECT id FROM public.vehicles WHERE household_id IN (${householdList}));

      -- d. schedule_versions.generated_by (set NULL to preserve published schedules)
      UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by IN (${profileIdList});

      -- e. households (cascades: memberships, children, vehicles, join_codes, weekly_checkins, ride_requests)
      DELETE FROM public.households WHERE id IN (${householdList});

      -- f. audit_events
      DELETE FROM public.audit_events WHERE actor_profile_id IN (${profileIdList});

      -- g. profiles
      DELETE FROM public.profiles WHERE id IN (${profileIdList});
    `);
    console.log("    DB rows deleted.");
  } catch (e) {
    console.error("    DB deletion failed:", e.message);
    process.exit(1);
  }

  // 5. Delete auth users
  console.log("    Deleting auth users...");
  let deletedAuth = 0;
  for (const p of profileRows) {
    try {
      execSync(
        `curl -s -X DELETE -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users/${p.id}" > /dev/null`,
        { encoding: "utf-8" },
      );
      deletedAuth++;
    } catch {
      console.error(`    Failed to delete auth user: ${p.email}`);
    }
  }
  console.log(`    ${deletedAuth} auth users deleted.`);

  // 6. Verify
  const verify = runSql(`
    SELECT
      (SELECT count(*) FROM public.profiles WHERE email LIKE '%@seed.kidpool') AS profiles,
      (SELECT count(*) FROM public.households WHERE id IN (${householdList})) AS households,
      (SELECT count(*) FROM public.driver_availability WHERE driver_profile_id IN (${profileIdList})) AS driver_availability,
      (SELECT count(*) FROM public.audit_events WHERE actor_profile_id IN (${profileIdList})) AS audit_events;
  `);
  const v = verify.rows[0];
  const clean = Object.values(v).every((n) => Number(n) === 0);

  if (clean) {
    console.log("\n  Verified clean — all seed data removed.\n");
  } else {
    console.error("\n  WARNING: some rows remain:", JSON.stringify(v), "\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n  Error:", e.message, "\n");
  process.exit(1);
});