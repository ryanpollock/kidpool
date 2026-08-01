#!/usr/bin/env node
// Hard-delete a user account and all related data from the live Supabase project.
//
// Usage:
//   npm run delete-user <email>          # delete if sole household member
//   npm run delete-user <email> --force   # delete even if household has co-parents
//
// Defaults to production (ujcrnrcgbvzyqosykkjy). Override with SUPABASE_PROJECT_REF.
// Requires: Supabase CLI linked to the target project (npm run link:prod).

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "ujcrnrcgbvzyqosykkjy";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

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

// ── Arg parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const force = args.includes("--force");
const email = args.find((a) => !a.startsWith("--"));

if (!email) {
  console.error("Usage: node scripts/delete-user.mjs <email> [--force]");
  process.exit(1);
}

// ── Service key resolution (mirrors tests/integration.test.mjs) ──
function getServiceKey() {
  if (process.env.SUPABASE_TEST_SERVICE_KEY) return process.env.SUPABASE_TEST_SERVICE_KEY;
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', {
      encoding: "utf8",
    }).trim();
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
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-delete-"));
  const file = path.join(tmpDir, "query.sql");
  writeFileSync(file, sql);
  try {
    const result = execSync(`supabase db query --linked -f "${file}" 2>/dev/null`, {
      encoding: "utf8",
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

// ── REST helper ──────────────────────────────────────────────────
function restGet(table, filters) {
  const filterStr = Object.entries(filters).map(([k, v]) => `${k}=eq.${v}`).join("&");
  const result = execSync(
    `curl -s -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/rest/v1/${table}?${filterStr}&select=*"`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(result);
}

function deleteAuthUser(userId) {
  execSync(
    `curl -s -X DELETE -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" "${SUPABASE_URL}/auth/v1/admin/users/${userId}" -w "\\n%{http_code}" -o /dev/null`,
    { encoding: "utf8" },
  );
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n  delete-user: ${email}${force ? " (--force)" : ""}\n`);

  // 1. Look up profile
  const profile = runSql(`SELECT id, email, full_name FROM public.profiles WHERE email = '${email}';`);
  const profileRows = profile.rows ?? [];
  if (profileRows.length === 0) {
    console.error("  Profile not found. Nothing to delete.\n");
    process.exit(1);
  }
  const { id: profileId, full_name: fullName } = profileRows[0];
  console.log(`  Profile: ${fullName} (${profileId})`);

  // 2. Look up household(s) + check for co-parents
  const memberships = runSql(`
    SELECT m.household_id, m.role, m.status, h.name
    FROM public.memberships m
    JOIN public.households h ON m.household_id = h.id
    WHERE m.profile_id = '${profileId}';
  `);
  const membershipRows = memberships.rows ?? [];
  const householdIds = membershipRows.map((m) => m.household_id);

  if (householdIds.length === 0) {
    console.log("  No household membership found.");
  } else {
    const householdList = householdIds.map((h) => `'${h}'`).join(",");
    const others = runSql(`
      SELECT m.profile_id, p.email, p.full_name, m.status
      FROM public.memberships m
      JOIN public.profiles p ON m.profile_id = p.id
      WHERE m.household_id IN (${householdList})
        AND m.profile_id != '${profileId}'
        AND m.status = 'active';
    `);
    const otherRows = others.rows ?? [];

    if (otherRows.length > 0 && !force) {
      console.error("\n  Household has other active members:");
      for (const r of otherRows) {
        console.error(`    ${r.full_name} (${r.email})`);
      }
      console.error("\n  Use --force to delete the entire household including their data.");
      process.exit(1);
    }
    if (otherRows.length > 0 && force) {
      console.log(`\n  WARNING: --force will delete ${otherRows.length} co-parent(s):`);
      for (const r of otherRows) {
        console.log(`    ${r.full_name} (${r.email})`);
      }
      console.log("");
    }
    for (const m of membershipRows) {
      console.log(`  Household: ${m.name} (${m.role})`);
    }
  }

  // 3. Collect data counts for summary
  const counts = runSql(`
    SELECT
      (SELECT count(*) FROM public.driver_confirmations WHERE driver_profile_id = '${profileId}') AS driver_confirmations,
      (SELECT count(*) FROM public.driver_assignments WHERE driver_profile_id = '${profileId}') AS driver_assignments_as_driver,
      (SELECT count(*) FROM public.driver_availability WHERE driver_profile_id = '${profileId}') AS driver_availability,
      (SELECT count(*) FROM public.schedule_versions WHERE generated_by = '${profileId}') AS schedule_versions_generated,
      (SELECT count(*) FROM public.audit_events WHERE actor_profile_id = '${profileId}') AS audit_events,
      (SELECT count(*) FROM public.weekly_checkins WHERE household_id IN (${householdIds.length ? householdIds.map((h) => `'${h}'`).join(",") : "NULL"})) AS checkins,
      (SELECT count(*) FROM public.children WHERE household_id IN (${householdIds.length ? householdIds.map((h) => `'${h}'`).join(",") : "NULL"})) AS children,
      (SELECT count(*) FROM public.vehicles WHERE household_id IN (${householdIds.length ? householdIds.map((h) => `'${h}'`).join(",") : "NULL"})) AS vehicles;
  `);
  const c = counts.rows[0];

  console.log("\n  Data to delete:");
  console.log(`    driver_confirmations:   ${c.driver_confirmations}`);
  console.log(`    driver_assignments:     ${c.driver_assignments_as_driver}`);
  console.log(`    driver_availability:    ${c.driver_availability}`);
  console.log(`    schedule_versions:      ${c.schedule_versions_generated} (generated_by nulled)`);
  console.log(`    households:             ${householdIds.length} (cascades memberships, children, vehicles, join_codes, checkins)`);
  console.log(`    children:               ${c.children}`);
  console.log(`    vehicles:               ${c.vehicles}`);
  console.log(`    checkins:               ${c.checkins}`);
  console.log(`    audit_events:           ${c.audit_events}`);

  // 4. Delete in FK-safe order
  const householdList = householdIds.length ? householdIds.map((h) => `'${h}'`).join(",") : "NULL";

  console.log("\n  Deleting...");
  try {
    runSql(`
      -- a. driver_confirmations (RESTRICT on driver_profile_id → profiles)
      DELETE FROM public.driver_confirmations WHERE driver_profile_id = '${profileId}';

      -- b. driver_assignments (RESTRICT on driver_profile_id + vehicle_id)
      DELETE FROM public.driver_assignments
      WHERE driver_profile_id = '${profileId}'
         OR vehicle_id IN (SELECT id FROM public.vehicles WHERE household_id IN (${householdList}));

      -- b2. rider_assignments (RESTRICT on child_id → children)
      DELETE FROM public.rider_assignments
      WHERE child_id IN (SELECT id FROM public.children WHERE household_id IN (${householdList}));

      -- c. driver_availability (RESTRICT on vehicle_id → vehicles)
      DELETE FROM public.driver_availability
      WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE household_id IN (${householdList}));

      -- d. schedule_versions.generated_by (NO ACTION → set NULL to preserve published schedules)
      UPDATE public.schedule_versions SET generated_by = NULL WHERE generated_by = '${profileId}';

      -- e. households (cascades: memberships, children, vehicles, join_codes, weekly_checkins → ride_requests)
      DELETE FROM public.households WHERE id IN (${householdList});

      -- f. audit_events (SET NULL on delete, but clean explicitly)
      DELETE FROM public.audit_events WHERE actor_profile_id = '${profileId}';

      -- g. profile
      DELETE FROM public.profiles WHERE id = '${profileId}';
    `);
    console.log("    DB rows deleted.");
  } catch (e) {
    console.error("    DB deletion failed:", e.message);
    process.exit(1);
  }

  // 5. Delete auth user
  console.log("    Deleting auth user...");
  try {
    deleteAuthUser(profileId);
    console.log("    Auth user deleted.");
  } catch (e) {
    console.error("    Auth user deletion failed:", e.message);
  }

  // 6. Verify
  const verify = runSql(`
    SELECT
      (SELECT count(*) FROM public.profiles WHERE id = '${profileId}' OR email = '${email}') AS profile,
      (SELECT count(*) FROM public.memberships WHERE profile_id = '${profileId}') AS membership,
      (SELECT count(*) FROM public.households WHERE id IN (${householdList})) AS household,
      (SELECT count(*) FROM public.driver_availability WHERE driver_profile_id = '${profileId}') AS driver_availability,
      (SELECT count(*) FROM public.audit_events WHERE actor_profile_id = '${profileId}') AS audit_events;
  `);
  const v = verify.rows[0];
  const clean = Object.values(v).every((n) => Number(n) === 0);

  if (clean) {
    console.log("\n  Verified clean — all data removed.\n");
  } else {
    console.error("\n  WARNING: some rows remain:", JSON.stringify(v), "\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n  Unexpected error:", e.message, "\n");
  process.exit(1);
});