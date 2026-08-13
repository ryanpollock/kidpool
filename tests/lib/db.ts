// Direct Postgres access for tests. Replaces the slow
// `supabase db query --linked` subprocess (1–3s per call) with a pooled
// pg connection (~10ms per call).

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getTestEnv, PILOT_GROUP_ID, type TestEnv } from "./env.ts";

export type TestDb = {
  pool: Pool;
  env: TestEnv;
  /** Run a SQL string and return rows (or empty array for non-row statements). */
  runSql<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<T[]>;
  /** Run a SQL string, ignore rows. Convenience for setup/teardown. */
  exec(sql: string): Promise<void>;
  /** Truncate the given tables in one statement. Caller is responsible for
   *  ordering (or using CASCADE). Tables should be unprefixed (e.g. "weeks"). */
  truncate(tables?: string[], cascade?: boolean): Promise<void>;
  /** Close the underlying pool. Call in afterAll. */
  close(): Promise<void>;
};

const SCHEMA_TABLES_IN_FK_ORDER = [
  "rider_assignments",
  "driver_confirmations",
  "driver_assignments",
  "schedule_versions",
  "ride_requests",
  "driver_availability",
  "weekly_checkins",
  "trips",
  "weeks",
  "audit_events",
  "vehicles",
  "children",
  "household_join_codes",
  "memberships",
  "households",
  "push_subscriptions",
  "profiles",
  // groups is intentionally NOT truncated — it's seeded by seed.sql
];

const CASCADE_SAFE_TRUNCATE = SCHEMA_TABLES_IN_FK_ORDER.map((t) => `public.${t}`).join(", ");

export function createTestDb(): TestDb {
  const env = getTestEnv();
  if (!env.dbUrl) {
    throw new Error(
      env.target === "staging"
        ? "SUPABASE_DB_URL is required when TEST_DB_TARGET=staging"
        : "Local Supabase DB URL missing. Is `supabase start` running?",
    );
  }
  const pool = new Pool({
    connectionString: env.dbUrl,
    max: 4,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    pool,
    env,
    async runSql<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<T[]> {
      const client: PoolClient = await pool.connect();
      try {
        const result: QueryResult<T> = await client.query<T>(sql);
        return result.rows ?? [];
      } finally {
        client.release();
      }
    },
    async exec(sql: string): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },
    async truncate(_tables?: string[], cascade = false): Promise<void> {
      // When called with no args, truncate the standard set in FK-safe order.
      // The CASCADE option uses a single TRUNCATE ... CASCADE which is simpler
      // but locks more aggressively. Use CASCADE only when truly needed.
      // Also delete test auth users (by email domain pattern) so the next
      // test file starts with no orphan auth.users rows.
      const sql = cascade
        ? `TRUNCATE ${CASCADE_SAFE_TRUNCATE} RESTART IDENTITY CASCADE;`
        : `TRUNCATE ${CASCADE_SAFE_TRUNCATE} RESTART IDENTITY;`;
      const client = await pool.connect();
      try {
        await client.query(sql);
        // Clean test auth users (created via admin API in tests). Safe because
        // real pilot parents sign in via Google OAuth — their emails don't
        // match these test domains.
        await client.query(
          "DELETE FROM auth.users WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool' OR email LIKE '%@lib.test.kidpool' OR email LIKE '%@seed.kidpool';",
        );
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Reset the test DB to a pristine state. Two modes:
 * - "truncate" (default, fast): TRUNCATE all test-owned tables, re-run seed
 *   group insert. ~50ms. Use between test files.
 * - "reset" (slow): `supabase db reset` via subprocess. ~10s. Use only when
 *   migrations themselves need to be re-applied (rare).
 */
export async function resetTestDb(mode: "truncate" | "reset" = "truncate"): Promise<void> {
  if (mode === "reset") {
    const { execSync } = await import("node:child_process");
    execSync("supabase db reset", { stdio: "inherit" });
    return;
  }
  const db = createTestDb();
  try {
    await db.truncate();
    // Re-seed the pilot group (matches supabase/seed.sql).
    await db.exec(`
      insert into public.groups (id, name, slug, timezone, meeting_point, school_name)
      values ('${PILOT_GROUP_ID}', 'Midtown Terrace–Presidio Carpool', 'midtown-presidio',
              'America/Los_Angeles', 'Midtown Terrace Playground', 'Presidio Middle School')
      on conflict (id) do update set
        name = excluded.name, slug = excluded.slug, timezone = excluded.timezone,
        meeting_point = excluded.meeting_point, school_name = excluded.school_name;
    `);
  } finally {
    await db.close();
  }
}