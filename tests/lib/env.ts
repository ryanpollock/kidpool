// Test environment configuration. Reads TEST_DB_TARGET to pick local vs staging.
// Default is "local" (Docker-based, fast, isolated). "staging" uses the old
// keychain + remote-pooler path as a backup.

export type TestDbTarget = "local" | "staging";

export type TestEnv = {
  target: TestDbTarget;
  supabaseUrl: string;
  serviceKey: string;
  anonKey: string;
  dbUrl: string;
  groupId: string;
};

const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

export const PILOT_GROUP_ID = "c1000000-0000-4000-8000-000000000001";

function readEnv(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Resolve test environment from process.env.
 *
 * - TEST_DB_TARGET=local (default): local Supabase in Docker.
 *   Keys are deterministic and shipped with the CLI, so no secrets needed.
 * - TEST_DB_TARGET=staging: remote staging project. Requires
 *   SUPABASE_TEST_SERVICE_KEY and SUPABASE_DB_URL in env (or keychain via
 *   tests/lib/auth.ts fallback). Used by the nightly smoke test.
 */
export function getTestEnv(): TestEnv {
  const target = (readEnv("TEST_DB_TARGET", "local") as TestDbTarget);
  if (target === "staging") {
    const supabaseUrl = readEnv("SUPABASE_URL", "https://jfyjgmhqnlbdcafoarrg.supabase.co");
    return {
      target: "staging",
      supabaseUrl,
      serviceKey: readEnv("SUPABASE_TEST_SERVICE_KEY"),
      anonKey: readEnv("SUPABASE_TEST_ANON_KEY"),
      dbUrl: readEnv("SUPABASE_DB_URL"),
      groupId: PILOT_GROUP_ID,
    };
  }
  return {
    target: "local",
    supabaseUrl: LOCAL_URL,
    serviceKey: LOCAL_SERVICE_KEY,
    anonKey: LOCAL_ANON_KEY,
    dbUrl: LOCAL_DB_URL,
    groupId: PILOT_GROUP_ID,
  };
}