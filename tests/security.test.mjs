// Exchange 7 — source-level RLS authorization tests.
// These tests regex-assert that the migration SQL defines the expected
// policies and helper functions, that no protected table is exposed
// without authentication, and that cross-household and coordinator-only
// invariants hold in the policy text. They do not execute queries against
// a live database — that is a separate, heavier option.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202607300001_exchange_1_foundation.sql",
  import.meta.url,
);
const exchange6Url = new URL(
  "../supabase/migrations/202607310001_exchange_6_confirmation_reason.sql",
  import.meta.url,
);

const protectedTables = [
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

const coordinatorOnlyTables = [
  "weeks",
  "trips",
  "schedule_versions",
  "driver_assignments",
  "rider_assignments",
];

const householdScopedTables = [
  "children",
  "vehicles",
  "weekly_checkins",
];

let cachedSql;
let cachedEx6Sql;

async function loadSql() {
  if (!cachedSql) cachedSql = await readFile(migrationUrl, "utf8");
  return cachedSql;
}

async function loadEx6Sql() {
  if (!cachedEx6Sql) cachedEx6Sql = await readFile(exchange6Url, "utf8");
  return cachedEx6Sql;
}

test("Exchange 7 RLS enables row-level security on every protected table", async () => {
  const sql = await loadSql();
  for (const table of protectedTables) {
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      `RLS not enabled on ${table}`,
    );
  }
});

test("Exchange 7 RLS exposes no protected table to anon or public", async () => {
  const sql = await loadSql();
  const anonPolicyPattern = /create policy\s+\w+\s+on public\.\w+\s+for\s+\w+\s+to\s+(anon|public)\b/i;
  assert.doesNotMatch(
    sql,
    anonPolicyPattern,
    "Found a policy granting access to anon or public on a protected table",
  );
});

test("Exchange 7 RLS defines the four authorization helper functions as security definer", async () => {
  const sql = await loadSql();
  for (const helper of [
    "is_group_member",
    "is_group_coordinator",
    "is_household_member",
    "shares_group_with_profile",
  ]) {
    assert.match(
      sql,
      new RegExp(`create or replace function public\\.${helper}\\b`),
      `missing helper ${helper}`,
    );
  }
  const definerCount = (sql.match(/security definer/g) || []).length;
  assert.ok(definerCount >= 4, "expected at least 4 security-definer functions");
});

test("Exchange 7 RLS gates coordinator-only tables with is_group_coordinator", async () => {
  const sql = await loadSql();
  for (const table of coordinatorOnlyTables) {
    const blockRegex = new RegExp(
      `create policy \\w+_manage_coordinator\\s+on public\\.${table} for all to authenticated[\\s\\S]*?is_group_coordinator\\(group_id\\)`,
    );
    assert.match(
      sql,
      blockRegex,
      `${table} is missing a coordinator-only manage policy`,
    );
  }
});

test("Exchange 7 RLS restricts household-scoped writes to is_household_member or coordinator", async () => {
  const sql = await loadSql();
  for (const table of householdScopedTables) {
    const insertRegex = new RegExp(
      `create policy \\w+_insert_household\\s+on public\\.${table} for insert to authenticated[\\s\\S]*?is_household_member\\(household_id\\)`,
    );
    assert.match(
      sql,
      insertRegex,
      `${table} insert policy does not require household membership`,
    );
  }
});

test("Exchange 7 RLS isolates children writes to the owning household", async () => {
  const sql = await loadSql();
  // Insert: creator must be the auth user AND a household member.
  assert.match(sql, /children_insert_household[\s\S]*?created_by = auth\.uid\(\)/);
  assert.match(sql, /children_insert_household[\s\S]*?is_household_member\(household_id\)/);
  // Update/delete: household member or coordinator only.
  assert.match(sql, /children_update_household[\s\S]*?is_household_member\(household_id\)/);
  assert.match(sql, /children_delete_household[\s\S]*?is_household_member\(household_id\)/);
  // Select: same-group only (cross-household within the same group is allowed).
  assert.match(sql, /children_select_group[\s\S]*?is_group_member\(group_id\)/);
});

test("Exchange 7 RLS isolates vehicles writes to the owning household", async () => {
  const sql = await loadSql();
  assert.match(sql, /vehicles_insert_household[\s\S]*?created_by = auth\.uid\(\)/);
  assert.match(sql, /vehicles_insert_household[\s\S]*?is_household_member\(household_id\)/);
  assert.match(sql, /vehicles_update_household[\s\S]*?is_household_member\(household_id\)/);
  assert.match(sql, /vehicles_delete_household[\s\S]*?is_household_member\(household_id\)/);
  assert.match(sql, /vehicles_select_group[\s\S]*?is_group_member\(group_id\)/);
});

test("Exchange 7 RLS restricts driver_availability to the driver or coordinator", async () => {
  const sql = await loadSql();
  assert.match(sql, /availability_manage_driver[\s\S]*?driver_profile_id = auth\.uid\(\)/);
  assert.match(sql, /availability_manage_driver[\s\S]*?is_group_coordinator\(group_id\)/);
  assert.match(sql, /availability_select_group[\s\S]*?is_group_member\(group_id\)/);
});

test("Exchange 7 RLS audit_events insert requires actor = auth.uid and group membership", async () => {
  const sql = await loadSql();
  assert.match(sql, /audit_events_insert_member[\s\S]*?actor_profile_id = auth\.uid\(\)/);
  assert.match(sql, /audit_events_insert_member[\s\S]*?is_group_member\(group_id\)/);
  assert.match(sql, /audit_events_select_group[\s\S]*?is_group_member\(group_id\)/);
});

test("Exchange 7 RLS profiles are visible only to self or same-group members", async () => {
  const sql = await loadSql();
  assert.match(sql, /profiles_select_group[\s\S]*?id = auth\.uid\(\) or public\.shares_group_with_profile\(id\)/);
  assert.match(sql, /profiles_update_self[\s\S]*?id = auth\.uid\(\)/);
});

test("Exchange 7 RLS memberships are visible to self or same-group only", async () => {
  const sql = await loadSql();
  assert.match(
    sql,
    /memberships_select_group_or_self[\s\S]*?profile_id = auth\.uid\(\) or public\.is_group_member\(group_id\)/,
  );
  assert.match(sql, /memberships_update_coordinator[\s\S]*?is_group_coordinator\(group_id\)/);
});

test("Exchange 7 RLS join codes are scoped to household members or coordinator", async () => {
  const sql = await loadSql();
  assert.match(sql, /join_codes_select_household[\s\S]*?is_household_member\(household_id\)/);
  assert.match(sql, /join_codes_manage_household[\s\S]*?is_household_member\(household_id\)/);
});

test("Exchange 7 RLS ride_requests are scoped to the owning checkin's household", async () => {
  const sql = await loadSql();
  assert.match(sql, /ride_requests_manage_household[\s\S]*?created_by = auth\.uid\(\)/);
  assert.match(
    sql,
    /ride_requests_manage_household[\s\S]*?checkin\.id = checkin_id[\s\S]*?is_household_member\(checkin\.household_id\)/,
  );
  assert.match(sql, /ride_requests_select_group[\s\S]*?is_group_member\(group_id\)/);
});

test("Exchange 7 RLS confirmations are group-scoped for select with no public write policy", async () => {
  const sql = await loadSql();
  assert.match(sql, /confirmations_select_group[\s\S]*?is_group_member\(group_id\)/);
  // confirmations are written only via the security-definer RPC, not a direct policy.
  const insertPolicy = /create policy \w+_insert\w*\s+on public\.driver_confirmions for insert/i;
  assert.doesNotMatch(sql, insertPolicy, "driver_confirmations should not have a direct insert policy");
});

test("Exchange 7 respond_to_driver_assignment RPC is security definer and enforces the assigned driver", async () => {
  const sql = await loadEx6Sql();
  assert.match(sql, /security definer/);
  assert.match(sql, /if auth\.uid\(\) is null then/);
  assert.match(sql, /if assignment\.driver_profile_id <> auth\.uid\(\) then/);
  assert.match(sql, /raise exception 'Only the assigned driver can respond'/);
  assert.match(sql, /insert into public\.audit_events/);
  assert.match(sql, /'driver_assignment_responded'/);
});

test("Exchange 7 create_household_with_membership RPC authenticates before write and audits", async () => {
  const sql = await loadSql();
  assert.match(sql, /create_household_with_membership[\s\S]*?security definer/);
  assert.match(sql, /create_household_with_membership[\s\S]*?if auth\.uid\(\) is null then/);
  assert.match(sql, /create_household_with_membership[\s\S]*?insert into public\.audit_events/);
});

test("Exchange 7 join_household_by_code RPC authenticates before write", async () => {
  const sql = await loadSql();
  assert.match(sql, /join_household_by_code[\s\S]*?security definer/);
  assert.match(sql, /join_household_by_code[\s\S]*?if auth\.uid\(\) is null then/);
});