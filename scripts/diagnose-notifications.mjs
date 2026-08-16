#!/usr/bin/env node
// Diagnose why the "Tomorrow's carpool" (night_before_summary) email isn't sending.
//
// Usage:
//   node scripts/diagnose-notifications.mjs           # production (default)
//   node scripts/diagnose-notifications.mjs --staging  # staging
//
// Read-only: queries cron jobs, vault secrets, wrapper functions, and the
// published schedule's assignment statuses. Prints a PASS/FAIL report.
// Requires: Supabase CLI linked to the target project (npm run link:prod / link:test).

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const STAGING_REF = "jfyjgmhqnlbdcafoarrg";
const args = process.argv.slice(2);
const PROJECT_REF = args.includes("--staging") ? STAGING_REF : PRODUCTION_REF;

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp/project-ref"), "utf8").trim();
    if (linkedRef !== PROJECT_REF) {
      const want = PROJECT_REF === PRODUCTION_REF ? "npm run link:prod" : "npm run link:test";
      console.error(`CLI linked to ${linkedRef} but target is ${PROJECT_REF}. Run "${want}".`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref. Run 'npm run link:prod' or 'npm run link:test'.");
    process.exit(1);
  }
}
verifyLinkedProject();

function runSql(sql) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-diag-"));
  const file = path.join(tmpDir, "q.sql");
  writeFileSync(file, sql);
  try {
    const result = execSync(`supabase db query --linked -f "${file}" 2>/dev/null`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(result).rows ?? [];
  } catch (e) {
    try {
      const parsed = JSON.parse(e.stdout || '{"rows":[]}');
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.rows ?? [];
    } catch {
      throw new Error(`SQL failed: ${e.message}`);
    }
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const WARN = "\x1b[33mWARN\x1b[0m";

function main() {
  console.log(`\n  diagnose-notifications — ${PROJECT_REF === PRODUCTION_REF ? "PRODUCTION" : "STAGING"}\n`);

  let failures = 0;

  // ── 1. Cron jobs ──────────────────────────────────────────────
  console.log("  1. Scheduled cron jobs");
  const cronJobs = runSql(`
    select jobname, schedule, active
    from cron.job
    where jobname in ('night-before-summary','drive-reminder','generate-schedule-sunday','generate-schedule-saturday','expire-unconfirmed-assignments')
    order by jobname;`);
  if (cronJobs.length === 0) {
    console.log(`     ${FAIL} No notification cron jobs found — migrations 202608070000/006/007 not applied`);
    failures++;
  } else {
    for (const j of cronJobs) {
      const needed = ["night-before-summary", "drive-reminder", "generate-schedule-sunday"];
      const mark = needed.includes(j.jobname) && !j.active ? FAIL : PASS;
      console.log(`     ${mark} ${j.jobname}  schedule='${j.schedule}'  active=${j.active}`);
    }
  }
  const hasNightBefore = cronJobs.some((j) => j.jobname === "night-before-summary" && j.active);
  const hasGenSunday = cronJobs.some((j) => j.jobname === "generate-schedule-sunday" && j.active);
  if (!hasNightBefore) { failures++; }
  if (!hasGenSunday) { failures++; }

  // ── 2. Wrapper functions ──────────────────────────────────────
  console.log("\n  2. Wrapper functions (pg_proc)");
  const funcs = runSql(`
    select proname from pg_proc
    where proname in ('send_night_before_summary','send_drive_reminders','generate_schedule_cron')
    and pronamespace = (select oid from pg_namespace where nspname = 'public');`);
  const funcNames = funcs.map((f) => f.proname);
  for (const name of ["send_night_before_summary", "send_drive_reminders", "generate_schedule_cron"]) {
    const mark = funcNames.includes(name) ? PASS : FAIL;
    if (!funcNames.includes(name)) failures++;
    console.log(`     ${mark} public.${name}()`);
  }

  // ── 3. Vault secrets (names only) ──────────────────────────────
  console.log("\n  3. Vault secrets (names only — values hidden)");
  const secrets = runSql(`select name from vault.secrets where name in ('cron_secret','cron_edge_base_url') order by name;`);
  const secretNames = secrets.map((s) => s.name);
  for (const name of ["cron_secret", "cron_edge_base_url"]) {
    const mark = secretNames.includes(name) ? PASS : FAIL;
    if (!secretNames.includes(name)) failures++;
    console.log(`     ${mark} ${name}`);
  }

  // ── 4. Published schedule assignment statuses ─────────────────
  console.log("\n  4. Published schedule — driver_assignment statuses");
  const statuses = runSql(`
    select da.status, count(*)::int as n
    from schedule_versions sv
    join driver_assignments da on da.schedule_version_id = sv.id
    where sv.status = 'published'
    group by da.status order by da.status;`);
  if (statuses.length === 0) {
    console.log(`     ${WARN} No published schedule found in this project`);
  } else {
    for (const s of statuses) console.log(`     ${PASS} ${s.status}: ${s.n}`);
    const confirmedCount = statuses.find((s) => s.status === "confirmed")?.n ?? 0;
    const expiredCount = statuses.find((s) => s.status === "expired")?.n ?? 0;
    if (confirmedCount === 0 && expiredCount > 0) {
      console.log(`     ${WARN} Zero confirmed + ${expiredCount} expired — the night-before no_confirmed_drivers gate would skip the email`);
      console.log(`            (but this only matters if cron is firing — see #1/#3)`);
    }
  }

  // ── 5. Tomorrow's coverage (the exact night-before check) ──────
  console.log("\n  5. Tomorrow's trip coverage (Pacific date)");
  const tomorrow = runSql(`
    select (now() at time zone 'America/Los_Angeles')::date + 1 as tomorrow;`)[0]?.tomorrow;
  console.log(`     tomorrow (Pacific): ${tomorrow}`);
  const coverage = runSql(`
    select t.direction,
           count(da.id) filter (where da.status = 'confirmed')::int as confirmed,
           count(da.id) filter (where da.status = 'tentative')::int  as tentative,
           count(da.id) filter (where da.status = 'expired')::int   as expired,
           count(da.id) filter (where da.status = 'declined')::int  as declined
    from trips t
    left join schedule_versions sv on sv.week_id = t.week_id and sv.group_id = t.group_id and sv.status = 'published'
    left join driver_assignments da on da.trip_id = t.id and da.schedule_version_id = sv.id
    where t.service_date = '${tomorrow}'
    group by t.direction order by t.direction;`);
  if (coverage.length === 0) {
    console.log(`     ${WARN} No trips tomorrow (no school) — night-before would return 'no_school_tomorrow'`);
  } else {
    for (const c of coverage) {
      const hasDriver = c.confirmed > 0 || c.tentative > 0;
      const mark = hasDriver ? PASS : WARN;
      console.log(`     ${mark} ${c.direction}: confirmed=${c.confirmed} tentative=${c.tentative} expired=${c.expired} declined=${c.declined}`);
    }
  }

  // ── 6. Ryan's assignment (he said he's confirmed for Aug 13) ──
  console.log("\n  6. ryan.pollock@gmail.com — current week assignments");
  const ryan = runSql(`
    select t.service_date, t.direction, da.status
    from profiles p
    join driver_assignments da on da.driver_profile_id = p.id
    join schedule_versions sv on sv.id = da.schedule_version_id and sv.status = 'published'
    join trips t on t.id = da.trip_id
    where p.email = 'ryan.pollock@gmail.com'
    order by t.service_date, t.direction;`);
  if (ryan.length === 0) {
    console.log(`     ${WARN} No published driver_assignments for ryan.pollock@gmail.com`);
  } else {
    for (const r of ryan) {
      const mark = r.status === "confirmed" ? PASS : WARN;
      console.log(`     ${mark} ${r.service_date} ${r.direction}: ${r.status}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log("\n  ── Summary ──────────────────────────────────────");
  if (failures === 0) {
    console.log(`  ${PASS} All cron jobs, functions, and secrets are present.`);
    console.log("     If the email still isn't arriving, the Edge Function logs will show");
    console.log("     the exact no-op reason — check Supabase > Functions > send-push logs.");
  } else {
    console.log(`  ${FAIL} ${failures} problem(s) found above — these explain the silence.`);
    console.log("     Fix: apply the missing migration(s) to this project, then set any");
    console.log("     missing vault secrets via `supabase secrets set`.");
  }
  console.log("");
}

try {
  main();
} catch (e) {
  console.error("\n  Diagnose failed:", e.message, "\n");
  process.exit(1);
}