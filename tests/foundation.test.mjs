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

  for (const table of expectedTables) {
    assert.match(
      types,
      new RegExp(`\\b${table}: Table<`),
      `missing TypeScript table contract for ${table}`,
    );
  }
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
