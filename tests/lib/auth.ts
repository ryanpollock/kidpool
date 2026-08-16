// Test user management. Creates and deletes auth users via the Supabase
// admin API. Works against both local (deterministic service key) and
// staging (keychain fallback for backward compat with old test scripts).

import { execSync } from "node:child_process";
import { getTestEnv, type TestEnv } from "./env.ts";

export const TEST_PASSWORD = "TestPass123!";

interface AdminUser {
  id: string;
  email: string;
}

function adminUsersUrl(env: TestEnv): string {
  return `${env.supabaseUrl}/auth/v1/admin/users`;
}

function adminUserUrl(env: TestEnv, id: string): string {
  return `${env.supabaseUrl}/auth/v1/admin/users/${id}`;
}

function curlAdmin(env: TestEnv, method: "GET" | "POST" | "DELETE", url: string, body?: object): unknown {
  const args = [
    "-s",
    "-X", method,
    "-H", `apikey: ${env.serviceKey}`,
    "-H", `Authorization: Bearer ${env.serviceKey}`,
    "-H", "Content-Type: application/json",
  ];
  if (body) args.push("-d", JSON.stringify(body));
  args.push(url);
  const result = execSync(`curl ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  try {
    return JSON.parse(result);
  } catch {
    return {};
  }
}

export function createTestUser(env: TestEnv, email: string): string | null {
  // Delete any existing user first (idempotent)
  deleteTestUserByEmail(env, email);

  const body = {
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: email },
  };
  const result = curlAdmin(env, "POST", adminUsersUrl(env), body) as { id?: string };
  return result.id ?? null;
}

export function deleteTestUser(env: TestEnv, userId: string): void {
  if (!userId) return;
  try {
    curlAdmin(env, "DELETE", adminUserUrl(env, userId));
  } catch {
    /* best effort */
  }
}

export function deleteTestUserByEmail(env: TestEnv, email: string): void {
  // For local: hit the admin API directly.
  // For staging: also try SQL via the db helper (kept here for backward compat).
  try {
    const list = curlAdmin(env, "GET", `${adminUsersUrl(env)}?per_page=1000`) as {
      users?: AdminUser[]; id?: string; email?: string;
    };
    const users = list.users ?? (Array.isArray(list) ? list : []);
    for (const u of users) {
      if (u.email === email) {
        deleteTestUser(env, u.id);
        return;
      }
    }
  } catch {
    /* best effort */
  }
}

/** Bulk delete test users by email pattern. Used in afterAll cleanup. */
export function deleteTestUsersByDomain(env: TestEnv, domain: string): void {
  try {
    const list = curlAdmin(env, "GET", `${adminUsersUrl(env)}?per_page=1000`) as {
      users?: AdminUser[]; id?: string; email?: string;
    };
    const users = list.users ?? (Array.isArray(list) ? list : []);
    for (const u of users) {
      if (u.email && u.email.endsWith(domain)) {
        deleteTestUser(env, u.id);
      }
    }
  } catch {
    /* best effort */
  }
}