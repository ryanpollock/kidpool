#!/usr/bin/env node
// Week status report: driver confirmation state, uncovered trips, check-in submission.
//
// Usage:
//   node scripts/week-status.mjs              # production (default)
//   node scripts/week-status.mjs --staging    # staging
//   node scripts/week-status.mjs --week 2026-08-24  # specific week (Monday date)
//
// Read-only. Prints a formatted report of the upcoming (or specified) week's
// schedule: per-trip driver roster with confirmation status, uncovered riders,
// and household check-in submission status.
// Requires: Supabase CLI linked to the target project (npm run link:prod / link:test).

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const STAGING_REF = "jfyjgmhqnlbdcafoarrg";
const args = process.argv.slice(2);
const PROJECT_REF = args.includes("--staging") ? STAGING_REF : PRODUCTION_REF;
const weekArg = args.find((a) => a.startsWith("--week="))?.split("=")[1]
  ?? (args.indexOf("--week") >= 0 ? args[args.indexOf("--week") + 1] : undefined);

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
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-week-"));
  const file = path.join(tmpDir, "q.sql");
  writeFileSync(file, sql);
  try {
    let result = execSync(`supabase db query --linked -f "${file}" 2>/dev/null`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const jsonStart = result.indexOf("{");
    if (jsonStart > 0) result = result.slice(jsonStart);
    return JSON.parse(result).rows ?? [];
  } catch (e) {
    try {
      let stdout = e.stdout || "";
      const jsonStart = stdout.indexOf("{");
      if (jsonStart > 0) stdout = stdout.slice(jsonStart);
      const parsed = JSON.parse(stdout || '{"rows":[]}');
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.rows ?? [];
    } catch {
      throw new Error(`SQL failed: ${e.message}`);
    }
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function main() {
  // ── 1. Find the target week ────────────────────────────────────
  const weekFilter = weekArg
    ? `w.starts_on = '${weekArg}'`
    : `w.starts_on >= (now() at time zone 'America/Los_Angeles')::date`;

  const weekRows = runSql(`
    select w.id, w.starts_on, w.status, w.confirmation_deadline,
           g.name as group_name
    from weeks w
    join groups g on g.id = w.group_id
    where ${weekFilter}
    order by w.starts_on asc
    limit 1;`);

  if (weekRows.length === 0) {
    console.log(`\n  No upcoming week found.\n`);
    return;
  }

  const week = weekRows[0];

  // ── 2. Find the latest schedule version ────────────────────────
  const versionRows = runSql(`
    select id, version_number, status, algorithm_version
    from schedule_versions
    where week_id = '${week.id}'
    order by version_number desc
    limit 1;`);

  if (versionRows.length === 0) {
    console.log(`\n  Week of ${week.starts_on} — no schedule version generated yet.\n`);
    return;
  }

  const version = versionRows[0];
  const versionId = version.id;

  // ── 3. Trips ───────────────────────────────────────────────────
  const trips = runSql(`
    select id, service_date, direction, meeting_time, origin, destination
    from trips
    where week_id = '${week.id}'
    order by service_date asc, direction asc;`);

  if (trips.length === 0) {
    console.log(`\n  Week of ${week.starts_on} — no trips.\n`);
    return;
  }

  // ── 4. Driver assignments + driver profiles + vehicles ─────────
  const tripIds = trips.map((t) => `'${t.id}'`).join(",");
  const drivers = runSql(`
    select da.id, da.trip_id, da.status, da.child_passenger_capacity,
           p.full_name as driver_name,
           v.label as vehicle_label
    from driver_assignments da
    join profiles p on p.id = da.driver_profile_id
    left join vehicles v on v.id = da.vehicle_id
    where da.schedule_version_id = '${versionId}'
      and da.trip_id in (${tripIds})
    order by da.trip_id, p.full_name;`);

  // ── 5. Rider assignments + child names ─────────────────────────
  const daIds = drivers.map((d) => `'${d.id}'`).join(",");
  const riders = daIds
    ? runSql(`
        select ra.driver_assignment_id, ra.child_id,
               c.first_name, c.last_name
        from rider_assignments ra
        join children c on c.id = ra.child_id
        where ra.driver_assignment_id in (${daIds});`)
    : [];

  // Map: driver_assignment_id → [child names]
  const kidsByDriver = new Map();
  for (const r of riders) {
    const arr = kidsByDriver.get(r.driver_assignment_id) ?? [];
    arr.push(`${r.first_name} ${r.last_name}`.trim());
    kidsByDriver.set(r.driver_assignment_id, arr);
  }

  // ── 6. Uncovered riders (from submitted check-ins only) ──────
  const uncoveredRows = runSql(`
    select rr.trip_id, c.first_name, c.last_name
    from ride_requests rr
    join weekly_checkins wc on wc.id = rr.checkin_id and wc.status = 'submitted'
    join children c on c.id = rr.child_id and c.active = true
    where rr.needs_ride = true
      and rr.trip_id in (${tripIds})
      and not exists (
        select 1 from rider_assignments ra
        join driver_assignments da on da.id = ra.driver_assignment_id
        where ra.child_id = rr.child_id
          and da.trip_id = rr.trip_id
          and da.schedule_version_id = '${versionId}'
          and da.status = 'confirmed'
      );`);

  const uncoveredByTrip = new Map();
  for (const u of uncoveredRows) {
    const arr = uncoveredByTrip.get(u.trip_id) ?? [];
    arr.push(`${u.first_name} ${u.last_name}`.trim());
    uncoveredByTrip.set(u.trip_id, arr);
  }

  // ── 7. Check-in submission status ──────────────────────────────
  const checkinRows = runSql(`
    select h.id, h.name, coalesce(wc.status::text, 'not_started') as status
    from households h
    left join weekly_checkins wc on wc.household_id = h.id and wc.week_id = '${week.id}'
    where h.group_id = (select group_id from weeks where id = '${week.id}')
    order by h.name;`);

  // ── 8. Print the report ────────────────────────────────────────
  console.log("");
  console.log(`  ${BOLD}Week of ${week.starts_on}${RESET} — ${week.group_name}`);
  console.log(`  Schedule: ${version.status} (v${version.version_number}, ${version.algorithm_version})`);

  // Format confirmation deadline
  if (week.confirmation_deadline) {
    const dl = runSql(`
      select to_char('${week.confirmation_deadline}'::timestamptz at time zone 'America/Los_Angeles',
                      'Dy MM/DD at HH12:MI AM') as deadline;`)[0]?.deadline ?? "";
    console.log(`  Confirmation deadline: ${dl} Pacific`);
  }
  console.log("");

  // Summary counts
  const confirmed = drivers.filter((d) => d.status === "confirmed");
  const tentative = drivers.filter((d) => d.status === "tentative");
  const declined = drivers.filter((d) => d.status === "declined");
  const expired = drivers.filter((d) => d.status === "expired");
  const released = drivers.filter((d) => d.status === "released");
  const uncoveredTrips = trips.filter((t) => !drivers.some((d) => d.trip_id === t.id));

  console.log(`  ${GREEN}✅ ${confirmed.length} confirmed${RESET}  ${YELLOW}⏳ ${tentative.length} tentative${RESET}  ${RED}⚠️ ${uncoveredTrips.length} no driver${RESET}  ${RED}✗ ${declined.length} declined${RESET}${expired.length ? `  ${DIM}⌛ ${expired.length} expired${RESET}` : ""}${released.length ? `  ${DIM}↻ ${released.length} released${RESET}` : ""}`);
  console.log("");

  // Per-trip roster
  const tripsByDate = new Map();
  for (const t of trips) {
    const arr = tripsByDate.get(t.service_date) ?? [];
    arr.push(t);
    tripsByDate.set(t.service_date, arr);
  }

  for (const [date, dayTrips] of [...tripsByDate.entries()].sort()) {
    const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    console.log(`  ${BOLD}${dateLabel}${RESET}`);

    for (const direction of ["morning", "afternoon"]) {
      const trip = dayTrips.find((t) => t.direction === direction);
      if (!trip) continue;

      const [h, m] = trip.meeting_time.split(":");
      const hour = parseInt(h, 10);
      const ampm = hour >= 12 ? "PM" : "AM";
      const hour12 = hour % 12 === 0 ? 12 : hour % 12;
      const time = `${hour12}:${m} ${ampm}`;
      const dirLabel = direction === "morning" ? "Morning" : "Afternoon";

      console.log(`    ${CYAN}${dirLabel} (${time})${RESET}`);

      const tripDrivers = drivers.filter((d) => d.trip_id === trip.id);
      if (tripDrivers.length === 0) {
        const uncovered = uncoveredByTrip.get(trip.id) ?? [];
        const kidStr = uncovered.length > 0 ? ` — ${uncovered.join(", ")}` : "";
        console.log(`      ${RED}⚠️ NO DRIVER${RESET}${uncovered.length ? ` — ${uncovered.length} rider${uncovered.length !== 1 ? "s" : ""} uncovered: ${uncovered.join(", ")}` : ""}`);
      } else {
        for (const d of tripDrivers) {
          const icon = d.status === "confirmed" ? `${GREEN}✅${RESET}` : d.status === "declined" ? `${RED}✗${RESET}` : d.status === "expired" ? `${DIM}⌛${RESET}` : `${YELLOW}⏳${RESET}`;
          const vehicleStr = d.vehicle_label ? ` (${d.vehicle_label})` : "";
          const kids = kidsByDriver.get(d.id) ?? [];
          const kidsStr = kids.length > 0 ? ` — ${kids.join(", ")}` : "";
          console.log(`      ${icon} ${d.driver_name}${vehicleStr} ${DIM}[${d.status}]${RESET}${kidsStr}`);
        }
      }

      // Uncovered riders on a trip that has drivers but not enough
      const uncovered = uncoveredByTrip.get(trip.id) ?? [];
      if (uncovered.length > 0 && tripDrivers.length > 0) {
        console.log(`      ${RED}⚠️ Uncovered: ${uncovered.join(", ")}${RESET}`);
      }
    }
    console.log("");
  }

  // Check-in status
  const submitted = checkinRows.filter((c) => c.status === "submitted");
  const draft = checkinRows.filter((c) => c.status === "draft");
  const notStarted = checkinRows.filter((c) => c.status === "not_started");

  console.log(`  ${BOLD}Check-ins${RESET}: ${GREEN}${submitted.length} submitted${RESET}  ${YELLOW}${draft.length} draft${RESET}  ${DIM}${notStarted.length} not started${RESET}`);
  if (draft.length > 0 || notStarted.length > 0) {
    const pending = [...draft, ...notStarted].map((c) => c.name).join(", ");
    console.log(`  ${DIM}Not submitted: ${pending}${RESET}`);
  }
  console.log("");
}

try {
  main();
} catch (e) {
  console.error("\n  Week status failed:", e.message, "\n");
  process.exit(1);
}