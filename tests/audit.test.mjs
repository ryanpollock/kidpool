// Exchange 7 — audit event emission tests.
// Source-level assertions that the repository and Edge Function emit
// audit_events rows for the human actions the MVP plan calls out:
// week creation, check-in submit/reopen, generate, publish, child/vehicle CRUD.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);
const edgeFunctionUrl = new URL(
  "../supabase/functions/generate-schedule/index.ts",
  import.meta.url,
);
const typesUrl = new URL(
  "../src/lib/supabase/database.types.ts",
  import.meta.url,
);

test("Exchange 7 repository defines a private best-effort recordAudit helper", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /private async recordAudit\(/);
  assert.match(source, /recordAudit[\s\S]*?Best-effort[\s\S]*?audit/);
  assert.match(source, /from\("audit_events"\)\.insert\(/);
  assert.match(source, /actor_profile_id: userResult\.data\.user\.id/);
  assert.match(source, /Best-effort: do not surface audit failures to the user\./);
});

test("Exchange 7 repository emits audit events for week creation", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /recordAudit\(\s*groupId,\s*"week_created"/);
  assert.match(source, /"week_created",\s*"week",/);
});

test("Exchange 7 repository emits audit events for check-in submit and reopen", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /recordAudit\(\s*updated\.group_id,\s*"checkin_submitted"/);
  assert.match(source, /recordAudit\(\s*updated\.group_id,\s*"checkin_reopened"/);
});

test("Exchange 7 repository emits audit events for child add/update/remove", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /recordAudit\(\s*groupId,\s*"child_added"/);
  assert.match(source, /recordAudit\(\s*updated\.group_id,\s*"child_updated"/);
  assert.match(source, /recordAudit\(\s*updated\.group_id,\s*"child_removed"/);
});

test("Exchange 7 repository emits audit events for vehicle add/update", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /recordAudit\(\s*groupId,\s*"vehicle_added"/);
  assert.match(source, /recordAudit\(\s*groupId,\s*"vehicle_updated"/);
});

test("Exchange 7 repository emits audit events for schedule publication", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /recordAudit\(\s*updated\.group_id,\s*"schedule_published"/);
});

test("Exchange 7 Edge Function emits a schedule_generated audit event", async () => {
  const source = await readFile(edgeFunctionUrl, "utf8");
  assert.match(source, /from\("audit_events"\)\.insert\(/);
  assert.match(source, /action: "schedule_generated"/);
  assert.match(source, /entity_type: "schedule_version"/);
  assert.match(source, /actor_profile_id: userId/);
  assert.match(source, /assignment_count/);
  assert.match(source, /algorithm: ALGORITHM_VERSION/);
});

test("Exchange 7 audit_events Insert type accepts actor_profile_id and details", async () => {
  const types = await readFile(typesUrl, "utf8");
  assert.match(types, /audit_events: Table</);
  assert.match(types, /actor_profile_id\?: string \| null/);
  assert.match(types, /entity_type: string/);
  assert.match(types, /details\?: Json/);
});