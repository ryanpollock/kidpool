// Unit tests for tests/lib/ helpers. Validates that the local Supabase
// connection works, runSql returns rows, truncate resets state, and
// test-user creation/deletion works against the admin API.
//
// Run: node --test tests/lib/db.test.mjs
// Requires: `supabase start` running locally.

import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, resetTestDb } from "./db.ts";
import { createTestUser, deleteTestUserByEmail, TEST_PASSWORD } from "./auth.ts";
import { getTestEnv } from "./env.ts";

const env = getTestEnv();
const skip = env.target !== "local";

test("env reports local target by default", { skip }, () => {
  assert.equal(env.target, "local");
  assert.equal(env.supabaseUrl, "http://127.0.0.1:54321");
  assert.match(env.dbUrl, /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322/);
});

test("runSql returns rows from groups table", { skip }, async () => {
  const db = createTestDb();
  try {
    const rows = await db.runSql<{ id: string; name: string }>(
      "select id, name from public.groups where id = 'c1000000-0000-4000-8000-000000000001'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Midtown Terrace–Presidio Carpool");
  } finally {
    await db.close();
  }
});

test("runSql returns empty array for no matches", { skip }, async () => {
  const db = createTestDb();
  try {
    const rows = await db.runSql("select * from public.profiles where 1 = 0");
    assert.equal(rows.length, 0);
  } finally {
    await db.close();
  }
});

test("exec runs non-row statements without throwing", { skip }, async () => {
  const db = createTestDb();
  try {
    await db.exec("create temp table tmp_test (id int); insert into tmp_test values (1);");
  } finally {
    await db.close();
  }
});

test("truncate clears test-owned tables but preserves groups seed", { skip }, async () => {
  // Create a real auth user first (profiles.id FKs to auth.users.id)
  const email = "truncate-test@lib.test.kidpool";
  const userId = createTestUser(env, email);
  assert.ok(userId, "test user created for FK");
  const db = createTestDb();
  try {
    await db.exec(`insert into public.profiles (id, email, full_name) values ('${userId}', '${email}', 'TT') on conflict do nothing;`);
    let rows = await db.runSql("select count(*)::int as n from public.profiles where email = 'truncate-test@lib.test.kidpool'");
    assert.equal(rows[0].n, 1);
    await db.truncate();
    rows = await db.runSql("select count(*)::int as n from public.profiles where email = 'truncate-test@lib.test.kidpool'");
    assert.equal(rows[0].n, 0);
    // Groups row from seed must survive
    const groups = await db.runSql("select count(*)::int as n from public.groups");
    assert.equal(groups[0].n, 1);
    // Auth user must also be cleared
    const authRows = await db.runSql("select count(*)::int as n from auth.users where email = 'truncate-test@lib.test.kidpool'");
    assert.equal(authRows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("resetTestDb('truncate') restores pristine state", { skip }, async () => {
  const email = "reset-test@lib.test.kidpool";
  const userId = createTestUser(env, email);
  assert.ok(userId, "test user created");
  const db = createTestDb();
  try {
    await db.exec(`insert into public.profiles (id, email, full_name) values ('${userId}', '${email}', 'RT') on conflict do nothing;`);
  } finally {
    await db.close();
  }
  await resetTestDb("truncate");
  const db2 = createTestDb();
  try {
    const rows = await db2.runSql("select count(*)::int as n from public.profiles where email = 'reset-test@lib.test.kidpool'");
    assert.equal(rows[0].n, 0);
    const groups = await db2.runSql("select count(*)::int as n from public.groups");
    assert.equal(groups[0].n, 1);
  } finally {
    await db2.close();
  }
});

test("createTestUser + deleteTestUserByEmail round-trips via admin API", { skip }, async () => {
  const email = "lib-test-create@lib.test.kidpool";
  // Pre-clean
  deleteTestUserByEmail(env, email);
  const userId = createTestUser(env, email);
  assert.ok(userId, "createTestUser returned a user id");
  try {
    // Verify the user exists via admin API
    const db = createTestDb();
    try {
      const rows = await db.runSql<{ id: string }>(
        `select id from auth.users where email = '${email}'`,
      );
      assert.equal(rows.length, 1, "user row exists in auth.users");
      assert.equal(rows[0].id, userId);
    } finally {
      await db.close();
    }
  } finally {
    deleteTestUserByEmail(env, email);
  }
  // Verify deletion
  const db = createTestDb();
  try {
    const rows = await db.runSql(`select count(*)::int as n from auth.users where email = '${email}'`);
    assert.equal(rows[0].n, 0, "user was deleted");
  } finally {
    await db.close();
  }
});