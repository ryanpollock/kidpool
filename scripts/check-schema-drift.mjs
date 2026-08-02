#!/usr/bin/env node
// Check for schema drift between live Supabase database and database.types.ts.
// Queries information_schema.columns from the linked project and compares
// against the hand-authored TypeScript types.
//
// Usage: npm run check:schema
// Requires: supabase CLI linked to the target project (staging or production).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function runSql(sql) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kidpool-drift-"));
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

// Parse database.types.ts to extract column names per *Row type
// Accounts for the Timestamps intersection: `export type XxxRow = Timestamps & { ... }`
function parseRowTypes(typesContent) {
  // First, extract Timestamps columns
  const timestampsMatch = typesContent.match(/type Timestamps = \{([^}]*)\}/s);
  const timestampCols = new Set();
  if (timestampsMatch) {
    const colPattern = /(\w+)[?:]?\s*:/g;
    let colMatch;
    while ((colMatch = colPattern.exec(timestampsMatch[1])) !== null) {
      timestampCols.add(colMatch[1]);
    }
  }

  const rowColumns = new Map();
  // Match: export type XxxRow = Timestamps & { ... } OR export type XxxRow = { ... }
  // Capture group 3 = "Timestamps" if present, group 4 = body
  const rowTypePattern = /export type (\w+Row)\s*=\s*(Timestamps\s*&\s*)?\{([^}]*)\}/gs;
  let match;
  while ((match = rowTypePattern.exec(typesContent)) !== null) {
    const typeName = match[1];
    const hasTimestamps = match[2] !== undefined;
    const body = match[3];
    const colPattern = /(\w+)[?:]?\s*:/g;
    const cols = new Set();
    if (hasTimestamps) {
      for (const tc of timestampCols) cols.add(tc);
    }
    let colMatch;
    while ((colMatch = colPattern.exec(body)) !== null) {
      cols.add(colMatch[1]);
    }
    rowColumns.set(typeName, cols);
  }
  return rowColumns;
}

// Map table names to Row type names
const tableToRowType = {
  children: "ChildRow",
  vehicles: "VehicleRow",
  profiles: "ProfileRow",
  groups: "GroupRow",
  households: "HouseholdRow",
  memberships: "MembershipRow",
  weeks: "WeekRow",
  trips: "TripRow",
  weekly_checkins: "WeeklyCheckinRow",
  ride_requests: "RideRequestRow",
  driver_availability: "DriverAvailabilityRow",
  schedule_versions: "ScheduleVersionRow",
  driver_assignments: "DriverAssignmentRow",
  rider_assignments: "RiderAssignmentRow",
  driver_confirmations: "DriverConfirmationRow",
  audit_events: "AuditEventRow",
};

async function main() {
  console.log("\n  check-schema-drift\n");

  const typesPath = path.join(import.meta.dirname, "..", "src", "lib", "supabase", "database.types.ts");
  const typesContent = readFileSync(typesPath, "utf8");
  const rowTypes = parseRowTypes(typesContent);

  // Query live DB schema
  const result = runSql(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name;
  `);

  const dbColumns = new Map(); // table_name -> Set<column_name>
  for (const row of result.rows) {
    if (!dbColumns.has(row.table_name)) dbColumns.set(row.table_name, new Set());
    dbColumns.get(row.table_name).add(row.column_name);
  }

  let drift = 0;

  // Check: DB columns missing from types
  for (const [tableName, rowTypeName] of Object.entries(tableToRowType)) {
    const dbCols = dbColumns.get(tableName);
    if (!dbCols) continue;
    const typeCols = rowTypes.get(rowTypeName);
    if (!typeCols) {
      console.error(`  MISSING: Row type ${rowTypeName} for table ${tableName} not found in database.types.ts`);
      drift++;
      continue;
    }

    // Skip internal columns that aren't in the Row type but exist in DB
    const skipCols = new Set(["id"]);
    // Some tables use gen_random_uuid() default but "id" IS in the Row type

    for (const col of dbCols) {
      if (!typeCols.has(col)) {
        console.error(`  DRIFT: DB column "${col}" on table "${tableName}" is missing from ${rowTypeName} in database.types.ts`);
        drift++;
      }
    }

    // Check: type columns that no longer exist in DB
    for (const col of typeCols) {
      if (!dbCols.has(col)) {
        console.warn(`  STALE: Type column "${col}" in ${rowTypeName} no longer exists on table "${tableName}" in DB`);
        drift++;
      }
    }
  }

  if (drift === 0) {
    console.log("  No schema drift detected. database.types.ts is in sync with live DB.\n");
    process.exit(0);
  } else {
    console.error(`\n  ${drift} drift issue(s) found. Fix database.types.ts or apply missing migrations.\n`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("\n  Error:", e.message, "\n"); process.exit(1); });