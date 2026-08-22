// Shared helpers for Playwright spec files. Provides the same setup
// pattern as integration.test.mjs but in TypeScript for .spec.ts files.
// Reads TEST_DB_TARGET to pick local vs staging, same as the other helpers.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTestEnv, type TestEnv } from "./env.ts";

export const PILOT_GROUP_ID = "c1000000-0000-4000-8000-000000000001";
export const TEST_PASSWORD = "TestPass123!";
export const UID = (n: number) => `deadbeef-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Local Supabase deterministic keys (shipped with the CLI).
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export type TestTarget = "local" | "staging";

export interface SpecEnv {
  target: TestTarget;
  supabaseUrl: string;
  serviceKey: string;
  anonKey: string;
  groupId: string;
  isLocal: boolean;
}

/** Resolve spec env. Call once at module load (not inside tests). */
export function getSpecEnv(): SpecEnv {
  const env = getTestEnv();
  if (env.target === "local") {
    return {
      target: "local",
      supabaseUrl: env.supabaseUrl,
      serviceKey: LOCAL_SERVICE_KEY,
      anonKey: LOCAL_ANON_KEY,
      groupId: PILOT_GROUP_ID,
      isLocal: true,
    };
  }
  // Staging path: keychain + project ref (legacy behavior preserved)
  const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
  const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
  if (PROJECT_REF === PRODUCTION_REF) {
    console.error("Aborting: spec tests must not run against production. Run with TEST_DB_TARGET=local or npm run link:test.");
    process.exit(1);
  }
  verifyLinkedProject();
  const serviceKey = process.env.SUPABASE_TEST_SERVICE_KEY || keychainKey("service_role");
  const anonKey = process.env.SUPABASE_TEST_ANON_KEY || keychainKey("anon");
  return {
    target: "staging",
    supabaseUrl: `https://${PROJECT_REF}.supabase.co`,
    serviceKey,
    anonKey,
    groupId: PILOT_GROUP_ID,
    isLocal: false,
  };
}

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(process.cwd(), "supabase/.temp/project-ref"), "utf8").trim();
    const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
    if (linkedRef !== PROJECT_REF) {
      console.error(`CLI linked to ${linkedRef} but PROJECT_REF is ${PROJECT_REF}. Run "npm run link:test".`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref. Run 'npm run link:test'.");
    process.exit(1);
  }
}

function keychainKey(id: "service_role" | "anon"): string {
  const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg";
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const result = execSync(
      `curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(result);
    const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
    for (const k of keyList) { if (k.id === id) return k.api_key; }
  } catch {}
  try {
    const keys = JSON.parse(readFileSync("/tmp/kidpool-test-keys.json", "utf8"));
    if (id === "service_role" && keys.serviceKey) return keys.serviceKey;
    if (id === "anon" && keys.anonKey) return keys.anonKey;
  } catch {}
  return "";
}

/** runSql — works against both local (docker exec psql) and staging (supabase db query --linked). */
export function makeRunSql(env: SpecEnv) {
  return function runSql(sql: string): { rows?: Array<Record<string, unknown>>; error?: { message: string } } {
    if (env.isLocal) {
      const trimmed = sql.trim();
      const isSelect = /^(with|select)\s/i.test(trimmed);
      // Strip trailing semicolons — they break inside the json_agg subquery wrapper
      const cleanSql = trimmed.replace(/;+\s*$/, "");
      const wrappedSql = isSelect
        ? `SELECT coalesce(json_agg(q), '[]'::json) FROM (${cleanSql}) q;`
        : trimmed;
      try {
        const result = execSync(
          `echo ${JSON.stringify(wrappedSql)} | docker exec -i supabase_db_carpool-app psql -U postgres -t -A -q 2>&1`,
          { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
        );
        if (isSelect) {
          try { return { rows: JSON.parse(result.trim() || "[]") }; } catch { return { rows: [] }; }
        }
        if (/^ERROR:/m.test(result)) return { error: { message: result.trim() } };
        return { rows: [] };
      } catch (e: unknown) {
        const stdout = (e as { stdout?: string; message?: string }).stdout || (e as { message?: string }).message || "";
        if (/^ERROR:/m.test(stdout)) return { error: { message: stdout.trim() } };
        return { rows: [] };
      }
    }
    // Staging: original subprocess approach (handles multi-statement natively)
    const tmpFile = `/tmp/kidpool-spec-query.sql`;
    execSync(`cat > "${tmpFile}" << 'ENDSQL'\n${sql}\nENDSQL`, { shell: "/bin/bash" });
    try {
      const result = execSync(`supabase db query --linked -f "${tmpFile}" 2>/dev/null`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      try { return JSON.parse(result); } catch { return {}; }
    } catch (e: unknown) {
      const stdout = (e as { stdout?: string }).stdout;
      if (stdout) { try { return JSON.parse(stdout); } catch {} }
      return {};
    }
  };
}

/** Test user management via admin API. Works against both local and staging. */
export function makeAuth(env: SpecEnv) {
  function createTestUser(email: string): string | null {
    // Delete any existing user first
    deleteTestUserByEmail(email);
    const body = JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: email } });
    try {
      const result = execSync(
        `curl -s -X POST -H "apikey: ${env.serviceKey}" -H "Authorization: Bearer ${env.serviceKey}" -H "Content-Type: application/json" -d '${body}' "${env.supabaseUrl}/auth/v1/admin/users"`,
        { encoding: "utf8" },
      );
      const parsed = JSON.parse(result);
      return parsed.id || null;
    } catch { return null; }
  }

  function deleteTestUser(userId: string) {
    if (!userId) return;
    try {
      execSync(`curl -s -X DELETE -H "apikey: ${env.serviceKey}" -H "Authorization: Bearer ${env.serviceKey}" "${env.supabaseUrl}/auth/v1/admin/users/${userId}" > /dev/null`, { encoding: "utf8" });
    } catch {}
  }

  function deleteTestUserByEmail(email: string) {
    try {
      const result = execSync(
        `curl -s -H "apikey: ${env.serviceKey}" -H "Authorization: Bearer ${env.serviceKey}" "${env.supabaseUrl}/auth/v1/admin/users?per_page=1000"`,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      const parsed = JSON.parse(result);
      const users = parsed.users || parsed || [];
      for (const user of users) {
        if (user.email === email) { deleteTestUser(user.id); }
      }
    } catch {}
  }

  function deleteTestUsersByDomain(domain: string) {
    try {
      const result = execSync(
        `curl -s -H "apikey: ${env.serviceKey}" -H "Authorization: Bearer ${env.serviceKey}" "${env.supabaseUrl}/auth/v1/admin/users?per_page=1000"`,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      const parsed = JSON.parse(result);
      const users = parsed.users || parsed || [];
      for (const user of users) {
        if (user.email && user.email.endsWith(domain)) { deleteTestUser(user.id); }
      }
    } catch {}
  }

  // Convenience: delete all test users across all known test domains.
  // Used by spec cleanup functions on the staging path.
  function deleteAllTestUsers() {
    for (const domain of ["@test.kidpool", "@e2e.kidpool", "@pilot.kidpool", "@crossfam.kidpool", "@cycle.kidpool", "@seed.kidpool"]) {
      deleteTestUsersByDomain(domain);
    }
  }

  return { createTestUser, deleteTestUser, deleteTestUserByEmail, deleteTestUsersByDomain, deleteAllTestUsers };
}

/** Truncate all test-owned tables for true isolation. Local mode only.
 *  Staging mode falls back to the spec's own cleanup function. */
export function truncateAll(runSql: (sql: string) => { rows?: unknown[]; error?: { message: string } }, groupId: string) {
  runSql(`
    TRUNCATE public.drive_status, public.rider_assignments, public.driver_confirmations, public.driver_assignments, public.schedule_versions, public.ride_requests, public.driver_availability, public.weekly_checkins, public.trips, public.weeks, public.audit_events, public.vehicles, public.children, public.household_join_codes, public.memberships, public.households, public.push_subscriptions, public.profiles RESTART IDENTITY;
    DELETE FROM auth.users WHERE email LIKE '%@test.kidpool' OR email LIKE '%@e2e.kidpool' OR email LIKE '%@pilot.kidpool' OR email LIKE '%@lib.test.kidpool';
    INSERT INTO public.groups (id, name, slug, timezone, meeting_point, school_name) VALUES ('${groupId}', 'Midtown Terrace–Presidio Carpool', 'midtown-presidio', 'America/Los_Angeles', 'Midtown Terrace Playground', 'Presidio Middle School') ON CONFLICT (id) DO UPDATE SET name = excluded.name, slug = excluded.slug, timezone = excluded.timezone, meeting_point = excluded.meeting_point, school_name = excluded.school_name;
  `);
}

/** Sign in via testAuth bypass. Works against both local and staging (in dev mode). */
export async function signInWithTestAuth(page: import("@playwright/test").Page, email: string) {
  await page.goto(`/?testAuth=${email}|${TEST_PASSWORD}`);
}