// Crewmate AI Phase 1 contract tests. Static checks over the migration,
// the chat-agent edge function, send-push's agent-reply gate, deploy
// plumbing, and the cleanup lists — no live DB. Mirrors chat.test.mjs
// conventions. Behavioral coverage lives in tests/integration.test.mjs
// ("Crewmate:" block) and tests/crewmate.spec.ts.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202609140001_crewmate_phase1.sql",
  import.meta.url,
);
const agentFnUrl = new URL("../supabase/functions/chat-agent/index.ts", import.meta.url);
const sendPushUrl = new URL("../supabase/functions/send-push/index.ts", import.meta.url);
const configTomlUrl = new URL("../supabase/config.toml", import.meta.url);
const deployWorkflowUrl = new URL(
  "../.github/workflows/deploy-edge-functions.yml",
  import.meta.url,
);
const typesUrl = new URL("../src/lib/supabase/database.types.ts", import.meta.url);
const repoUrl = new URL("../src/lib/supabase/carpool-repository.ts", import.meta.url);
const chatScreensUrl = new URL("../src/ChatScreens.tsx", import.meta.url);
const dbTruncateUrl = new URL("../tests/lib/db.ts", import.meta.url);
const integrationUrl = new URL("../tests/integration.test.mjs", import.meta.url);
const playwrightHelpersUrl = new URL("../tests/lib/playwright-helpers.ts", import.meta.url);
const evalScriptUrl = new URL("../scripts/crewmate-eval.mjs", import.meta.url);

test("crewmate ships disabled: group flag defaults false and gates the trigger", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /add column if not exists crewmate_enabled boolean not null default false/i,
    "crewmate_enabled must exist and default to false",
  );
  assert.match(sql, /add column if not exists crewmate_monthly_token_budget integer not null default 2000000/i);
  // The trigger consults the flag before posting to the edge function.
  assert.match(
    sql,
    /create or replace function public\.notify_chat_agent\(\)[\s\S]*?crewmate_enabled[\s\S]*?if not coalesce\(v_enabled, false\) then[\s\S]*?return new/i,
  );
});

test("agent threads: kind check, shape branch, and one per parent per group", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /check \(kind in \('dm', 'group', 'everyone', 'agent'\)\)/i);
  assert.match(
    sql,
    /kind = 'agent' and dm_a_id is null and dm_b_id is null and title is null/i,
    "agent threads must have the documented shape (no dm ids, no title)",
  );
  assert.match(
    sql,
    /create unique index if not exists chat_threads_agent_unique[\s\S]*?where kind = 'agent'/i,
    "one agent thread per (group, created_by)",
  );
});

test("ensure_agent_thread: member-gated, idempotent, disclosure preserved", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.ensure_agent_thread\(\w+ uuid\)/i);
  assert.match(sql, /ensure_agent_thread[\s\S]*?is_group_member\(target_group_id\)/i);
  assert.match(sql, /ensure_agent_thread[\s\S]*?on conflict do nothing/i);
  // Disclosure mentions Crewmate AI and the consent model — do not remove.
  assert.match(
    sql,
    /ensure_agent_thread[\s\S]*?'This is your private conversation with Crewmate AI[\s\S]*?nothing changes unless a parent confirms/i,
  );
  assert.match(sql, /revoke all on function public\.ensure_agent_thread\(uuid\) from public/i);
  assert.match(sql, /grant execute on function public\.ensure_agent_thread\(uuid\) to authenticated/i);
});

test("invoke trigger is parent-only, flag-gated, fail-soft, and mirrors the vault pattern", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.notify_chat_agent\(\)/i);
  assert.match(
    sql,
    /notify_chat_agent[\s\S]*?if new\.sender_kind <> 'parent' then[\s\S]*?return new/i,
    "agent/system messages must never invoke the agent (no self-trigger loops)",
  );
  assert.match(sql, /notify_chat_agent[\s\S]*?No cron_secret found in vault/);
  assert.match(sql, /notify_chat_agent[\s\S]*?No cron_edge_base_url found in vault/);
  assert.match(sql, /v_base_url \|\| '\/chat-agent'/);
  assert.match(sql, /'thread_id', new\.thread_id[\s\S]*?'message_id', new\.id/);
  assert.match(sql, /timeout_milliseconds := 120000/);
  assert.match(sql, /revoke all on function public\.notify_chat_agent\(\) from public, authenticated/i);
  assert.match(
    sql,
    /create trigger chat_messages_notify_agent[\s\S]*?after insert on public\.chat_messages/i,
  );
});

test("crewmate_runs ledger: statuses, RLS, coordinator-only reads, coalescing lock", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create table public\.crewmate_runs/);
  assert.match(
    sql,
    /status text not null[\s\S]*?'running', 'coalesced', 'skipped_budget', 'chatter',[\s\S]*?'answered', 'action_deferred', 'failed'/i,
  );
  assert.match(sql, /alter table public\.crewmate_runs enable row level security/i);
  assert.match(
    sql,
    /create policy crewmate_runs_select_coordinator[\s\S]*?for select to authenticated[\s\S]*?is_group_coordinator\(group_id\)/i,
  );
  // Only the select grant — writes are service-role only.
  assert.match(sql, /grant select on public\.crewmate_runs to authenticated/i);
  assert.doesNotMatch(sql, /grant (insert|update|all|delete) on public\.crewmate_runs to authenticated/i);
  assert.match(
    sql,
    /create unique index crewmate_runs_one_running_per_thread[\s\S]*?where status = 'running'/i,
  );
});

test("claim_crewmate_run: service-role only, reaps stale runs, coalesces via the partial index", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /create or replace function public\.claim_crewmate_run\([\s\S]*?auth\.role\(\), ''\) <> 'service_role' then[\s\S]*?raise exception 'Not allowed'/i,
  );
  assert.match(sql, /claim_crewmate_run[\s\S]*?stale_run_reaped/);
  assert.match(sql, /claim_crewmate_run[\s\S]*?on conflict do nothing[\s\S]*?returning id into v_run_id/);
  assert.match(sql, /claim_crewmate_run[\s\S]*?coalesced_count \+ 1/);
  assert.match(sql, /revoke all on function public\.claim_crewmate_run\(uuid, uuid, uuid\) from public, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_crewmate_run\(uuid, uuid, uuid\) to service_role/i);
});

test("crewmate_readonly role: nologin, narrow grants, no profiles or chat tables, no kid phones", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create role crewmate_readonly nologin/i);
  assert.match(sql, /grant crewmate_readonly to postgres/i);
  assert.match(sql, /grant usage on schema public to crewmate_readonly/i);
  // Operational schedule tables only.
  for (const table of [
    "groups", "memberships", "households", "vehicles", "weeks", "trips",
    "weekly_checkins", "ride_requests", "driver_availability", "driver_assignments",
    "rider_assignments", "schedule_versions", "driver_confirmations", "audit_events",
  ]) {
    assert.match(
      sql,
      new RegExp(`grant select on[\\s\\S]*?public\\.${table}\\b`, "i"),
      `crewmate_readonly must be able to read ${table}`,
    );
  }
  // Explicitly NOT granted: profiles (emails/phones) and the chat tables.
  assert.doesNotMatch(sql, /grant select[^\n;]*on[^\n;]*public\.profiles[^\n;]*to crewmate_readonly/i);
  for (const table of ["chat_threads", "chat_messages", "chat_proposals", "chat_participants"]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`grant select[^\\n;]*on[^\\n;]*public\\.${table}[^\\n;]*to crewmate_readonly`, "i"),
      `crewmate_readonly must not read ${table}`,
    );
  }
  // children is column-limited: phone and photo_url are drive-scoped, not agent-visible.
  assert.match(
    sql,
    /grant select \(id, group_id, household_id, first_name, last_name, active,\s*is_priority, preferred_buddy_child_id\)\s*on public\.children to crewmate_readonly/i,
  );
  assert.doesNotMatch(sql, /grant select on public\.children to crewmate_readonly/i);
});

test("readonly RLS policies scope every readable table to the transaction GUC", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  const policyMatches = sql.match(/create policy crewmate_readonly_\w+[\s\S]*?current_setting\('app\.crewmate_group', true\)::uuid/gi) ?? [];
  assert.ok(
    policyMatches.length >= 15,
    `expected >= 15 group-scoped readonly policies (groups + 14 group_id tables + children), found ${policyMatches.length}`,
  );
  for (const table of ["groups", "children", "trips", "driver_assignments", "rider_assignments"]) {
    assert.match(
      sql,
      new RegExp(`create policy crewmate_readonly_\\w+[\\s\\S]*?on public\\.${table} for select to crewmate_readonly`, "i"),
      `missing crewmate_readonly policy on ${table}`,
    );
  }
});

test("crewmate_readonly_query enforces single SELECT, keyword denylist, timeout, row cap", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /crewmate_readonly_query[\s\S]*?auth\.role\(\), ''\) <> 'service_role' then[\s\S]*?raise exception 'Not allowed'/i,
  );
  // SECURITY INVOKER by necessity: Postgres forbids SET ROLE inside
  // security-definer functions. The invoker (service_role) drops its own
  // privileges in the body.
  assert.match(
    sql,
    /create or replace function public\.crewmate_readonly_query\([\s\S]*?language plpgsql\s+security invoker/i,
  );
  assert.match(sql, /grant crewmate_readonly to service_role/i);
  assert.match(sql, /Only a single SELECT statement is allowed/);
  assert.match(sql, /Comments are not allowed/);
  assert.match(sql, /\^\(select\|with\)\\y/);
  assert.match(sql, /Forbidden keyword in query/);
  // The whole mutation/utility denylist, word-bounded.
  assert.match(
    sql,
    /\\y\(insert\|update\|delete\|merge\|alter\|drop\|truncate\|create\|grant\|revoke\|copy\|comment\|do\|into\|call\|listen\|notify\|set_config\|setval\|reset\|advisory\|lock\|share\|vacuum\|analyze\|reindex\|cluster\|prepare\|execute\|deallocate\|fetch\|move\|close\|current_setting\|import\|security\|sudo\)\\y/i,
  );
  assert.match(sql, /'\\mpg_' or v_sql ~\* '\\mlo_' or v_sql ~\* '\\mdblink'/);
  assert.match(sql, /set local statement_timeout = 5000/);
  assert.match(sql, /limit 500/);
  assert.match(sql, /set local role crewmate_readonly/);
  assert.match(sql, /set_config\('app\.crewmate_group', p_group_id::text, true\)/);
  assert.match(
    sql,
    /revoke all on function public\.crewmate_readonly_query\(uuid, text\) from public, authenticated/i,
  );
  assert.match(sql, /grant execute on function public\.crewmate_readonly_query\(uuid, text\) to service_role/i);
});

test("chat-agent function: trigger-authenticated, ledger-first, and Phase 1 write-free", async () => {
  const src = await readFile(agentFnUrl, "utf8");

  // Auth mirrors send-push: Bearer cron secret or service key.
  assert.match(src, /verifyAuth/);
  assert.match(src, /CRON_SECRET/);
  // Coalescing + budget + ledger are mandatory plumbing.
  assert.match(src, /claim_crewmate_run/);
  assert.match(src, /crewmate_monthly_token_budget/);
  assert.match(src, /crewmate_runs/);
  // The SQL tool must go through the grant-enforced RPC, never a raw query.
  assert.match(src, /rpc\("crewmate_readonly_query"/);
  // Agent messages are attributed.
  assert.match(src, /sender_kind: "agent"/);
  assert.match(src, /sender_name: "Crewmate AI"/);
  // Model IDs come from config, never hard-coded-only.
  assert.match(src, /CREWMATE_TRIAGE_MODEL/);
  assert.match(src, /CREWMATE_PLANNER_MODEL/);
  // Chat notifications are push-only — no email from the agent.
  assert.doesNotMatch(src, /api\.resend\.com/);

  // Phase 1 hard boundary: the function never references chat_proposals
  // and never writes a schedule table. Reads (select) are expected.
  assert.doesNotMatch(src, /from\("chat_proposals"\)/);
  const scheduleTables = [
    "trips", "weeks", "children", "vehicles", "households", "memberships",
    "groups", "ride_requests", "weekly_checkins", "driver_availability",
    "driver_assignments", "rider_assignments", "schedule_versions",
    "driver_confirmations", "audit_events", "chat_threads",
  ];
  for (const table of scheduleTables) {
    assert.doesNotMatch(
      src,
      new RegExp(`from\\("${table}"\\)[^;]*?\\.(insert|update|upsert|delete)\\(`, "s"),
      `chat-agent must not write ${table} in Phase 1`,
    );
  }
  // The only writes: agent messages + the ledger.
  assert.match(src, /from\("chat_messages"\)[\s\S]{0,200}\.insert\(/);
  assert.match(src, /from\("crewmate_runs"\)[\s\S]{0,400}\.update\(/);
});

test("chat-agent pushes replies only in private Crewmate threads", async () => {
  const src = await readFile(agentFnUrl, "utf8");
  const pushSrc = await readFile(sendPushUrl, "utf8");

  assert.match(src, /if \(thread\.kind === "agent"\)[\s\S]*?send-push/);
  // send-push accepts agent messages ONLY in kind='agent' threads.
  assert.match(
    pushSrc,
    /isAgentReply = message\.sender_kind === "agent"[\s\S]*?isAgentReply && thread\.kind === "agent"/,
  );
  assert.match(pushSrc, /thread\.kind === "dm" \|\| thread\.kind === "agent"/);
});

test("chat-agent is deployable: config entry + workflow step", async () => {
  const configToml = await readFile(configTomlUrl, "utf8");
  const workflow = await readFile(deployWorkflowUrl, "utf8");

  assert.match(configToml, /\[functions\.chat-agent\][\s\S]*?verify_jwt = false/);
  assert.match(workflow, /Deploy chat-agent/);
  assert.match(workflow, /supabase functions deploy chat-agent --no-verify-jwt/);
});

test("client types, repository, and UI know the agent thread kind", async () => {
  const types = await readFile(typesUrl, "utf8");
  const repo = await readFile(repoUrl, "utf8");
  const screens = await readFile(chatScreensUrl, "utf8");

  assert.match(types, /export type ChatThreadKind = "dm" \| "group" \| "everyone" \| "agent";/);
  assert.match(types, /crewmate_runs: Table</);
  assert.match(types, /ensure_agent_thread: \{/);
  assert.match(repo, /async ensureAgentThread\(groupId: string\): Promise<string>/);
  assert.match(repo, /rpc\("ensure_agent_thread"/);
  // Pinned entry + pinned inbox row + header copy.
  assert.match(screens, /data-testid="chat-new-chat-crewmate"/);
  assert.match(screens, /threads\.find\(\(t\) => t\.kind === "agent"\)/);
  assert.match(screens, /if \(thread\.kind === "agent"\) return "Crewmate AI";/);
  assert.match(screens, /chat-avatar--agent" aria-label="Crewmate AI"/);
  assert.match(screens, /ask it anything about the schedule/);
});

test("crewmate_runs joins every cleanup path in FK-safe position", async () => {
  const dbTruncate = await readFile(dbTruncateUrl, "utf8");
  const integration = await readFile(integrationUrl, "utf8");
  const helpers = await readFile(playwrightHelpersUrl, "utf8");

  // crewmate_runs references chat_threads and chat_messages, so it must be
  // truncated before both.
  const dbList = dbTruncate.match(/const SCHEMA_TABLES_IN_FK_ORDER = \[([\s\S]*?)\];/)?.[1] ?? "";
  assert.match(dbList, /"crewmate_runs"/);
  assert.ok(
    dbList.indexOf("crewmate_runs") < dbList.indexOf("chat_messages"),
    "db.ts: crewmate_runs must precede chat_messages",
  );
  assert.ok(
    dbList.indexOf("crewmate_runs") < dbList.indexOf("chat_threads"),
    "db.ts: crewmate_runs must precede chat_threads",
  );

  assert.match(integration, /TRUNCATE[\s\S]*?crewmate_runs/);
  assert.match(helpers, /truncateAll[\s\S]*?crewmate_runs|crewmate_runs[\s\S]*?TRUNCATE/);
});

test("eval harness exists and refuses production", async () => {
  const evalScript = await readFile(evalScriptUrl, "utf8");

  assert.match(evalScript, /ujcrnrcgbvzyqosykkjy/);
  assert.match(evalScript, /TOGETHER_API_KEY/);
  assert.match(evalScript, /Defaulting to staging|defaults to staging/i);
});