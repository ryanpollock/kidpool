import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202607300001_exchange_1_foundation.sql",
  import.meta.url,
);
const typesUrl = new URL(
  "../src/lib/supabase/database.types.ts",
  import.meta.url,
);
const envExampleUrl = new URL("../.env.example", import.meta.url);
const seedUrl = new URL("../supabase/seed.sql", import.meta.url);

const expectedTables = [
  "profiles",
  "groups",
  "households",
  "memberships",
  "household_join_codes",
  "children",
  "vehicles",
  "weeks",
  "trips",
  "weekly_checkins",
  "ride_requests",
  "driver_availability",
  "schedule_versions",
  "driver_assignments",
  "rider_assignments",
  "driver_confirmations",
  "audit_events",
];

// Tables defined in later migrations (not in the foundation migration)
const extendedTables = [
  "push_subscriptions",
];

test("foundation migration defines every MVP table and enables RLS", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /^\s*begin;/i);
  assert.match(sql, /commit;\s*$/i);

  for (const table of expectedTables) {
    assert.match(
      sql,
      new RegExp(`create table public\\.${table}\\b`, "i"),
      `missing table ${table}`,
    );
    assert.match(
      sql,
      new RegExp(
        `alter table public\\.${table} enable row level security`,
        "i",
      ),
      `RLS is not enabled for ${table}`,
    );
  }
});

test("foundation migration preserves named-roster and confirmation invariants", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /first_name text not null/i);
  assert.match(sql, /last_name text not null/i);
  assert.match(sql, /child_passenger_capacity between 1 and 12/i);
  assert.match(sql, /unique \(schedule_version_id, trip_id, child_id\)/i);
  assert.match(sql, /Vehicle child-passenger capacity exceeded/i);
  assert.match(sql, /only for its own children/i);
  assert.match(sql, /Driver, check-in, and vehicle must belong to one household/i);
  assert.match(sql, /Driver assignment trip must belong to the schedule week/i);
  assert.match(sql, /Only the assigned driver can respond/i);
  assert.match(sql, /assignment\.status <> 'tentative'/i);
  assert.match(sql, /status = case[\s\S]*'confirmed'[\s\S]*'declined'/i);
  assert.doesNotMatch(sql, /service_role/i);
});

test("every database table has a matching TypeScript contract", async () => {
  const types = await readFile(typesUrl, "utf8");

  for (const table of [...expectedTables, ...extendedTables]) {
    assert.match(
      types,
      new RegExp(`\\b${table}: Table<`),
      `missing TypeScript table contract for ${table}`,
    );
  }
});

test("every column added by ALTER TABLE migrations appears in database.types.ts", async () => {
  // Parse all migration files for "alter table ... add column" statements
  // and verify each column appears in the corresponding *Row type.
  const { readdir } = await import("node:fs/promises");
  const migrationDir = new URL("../supabase/migrations/", import.meta.url);
  const files = await readdir(migrationDir);
  const types = await readFile(typesUrl, "utf8");

  // Extract column names from *Row types in database.types.ts
  // Each Row type is: export type XxxRow = Timestamps & { col1: type; col2: type; ... };
  const rowTypePattern = /export type (\w+Row) = .*?\{([^}]*)\}/gs;
  const rowColumns = new Map(); // tableLowerName -> Set<columnName>
  let match;
  while ((match = rowTypePattern.exec(types)) !== null) {
    const typeName = match[1];
    const body = match[2];
    // "children" -> "ChildRow" -> table name "children"
    const colPattern = /(\w+)[?:]?\s*:/g;
    const cols = new Set();
    let colMatch;
    while ((colMatch = colPattern.exec(body)) !== null) {
      cols.add(colMatch[1]);
    }
    rowColumns.set(typeName, cols);
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
    weekly_checkins: "CheckinRow",
    ride_requests: "RideRequestRow",
    driver_availability: "DriverAvailabilityRow",
    schedule_versions: "ScheduleVersionRow",
    driver_assignments: "DriverAssignmentRow",
    rider_assignments: "RiderAssignmentRow",
    driver_confirmations: "DriverConfirmationRow",
    audit_events: "AuditEventRow",
    push_subscriptions: null, // no *Row type — uses inline Table<>
    household_join_codes: null,
  };

  let checked = 0;
  for (const file of files) {
    if (!file.endsWith(".sql")) continue;
    const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
    // Match: alter table public.xxx add column [if not exists] col_name ...
    // "column" is required to exclude "add constraint" statements
    const alterPattern = /alter table public\.(\w+)\s+add column\s+(?:if not exists\s+)?(\w+)/gi;
    let alterMatch;
    while ((alterMatch = alterPattern.exec(sql)) !== null) {
      const tableName = alterMatch[1];
      const colName = alterMatch[2];
      const rowType = tableToRowType[tableName];
      if (!rowType) continue; // skip tables without Row types
      const cols = rowColumns.get(rowType);
      if (!cols) {
        assert.fail(`Row type ${rowType} for table ${tableName} not found in database.types.ts (column: ${colName} from ${file})`);
      }
      assert.ok(
        cols.has(colName),
        `Column "${colName}" added to table "${tableName}" in ${file} is missing from ${rowType} in database.types.ts`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, "Should have found at least one ALTER TABLE ADD COLUMN to verify");
});

test("browser environment contract contains only public Supabase values", async () => {
  const envExample = await readFile(envExampleUrl, "utf8");

  assert.match(envExample, /^VITE_SUPABASE_URL=/m);
  assert.match(envExample, /^VITE_SUPABASE_PUBLISHABLE_KEY=/m);
  assert.doesNotMatch(envExample, /^VITE_.*(?:SERVICE|SECRET)/m);
});

test("development seed is repeatable and does not bypass Auth", async () => {
  const seed = await readFile(seedUrl, "utf8");

  assert.match(seed, /on conflict \(id\) do update/i);
  assert.match(seed, /Midtown Terrace–Presidio Carpool/);
  assert.doesNotMatch(seed, /insert into auth\.users/i);
});
