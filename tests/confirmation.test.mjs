import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);
const migrationUrl = new URL(
  "../supabase/migrations/202607310001_exchange_6_confirmation_reason.sql",
  import.meta.url,
);
const typesUrl = new URL(
  "../src/lib/supabase/database.types.ts",
  import.meta.url,
);
const envExampleUrl = new URL("../.env.example", import.meta.url);

test("Exchange 6 migration adds decline_reason and updates the RPC", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /add column if not exists decline_reason text/);
  assert.match(sql, /decline_reason text default null/);
  assert.match(sql, /when driver_response = 'declined' and decline_reason is not null/);
  assert.match(sql, /jsonb_build_object\([\s\S]*'decline_reason'/);
});

test("Exchange 6 types include decline_reason on driver_confirmations", async () => {
  const types = await readFile(typesUrl, "utf8");

  assert.match(types, /decline_reason: string \| null/);
  assert.match(types, /decline_reason\?: string \| null/);
  assert.match(types, /decline_reason\?: string \| null;\s*\};\s*Returns: DriverAssignmentRow/);
});

test("Exchange 6 repository exposes confirmation and publish methods", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /async getMyDriverAssignments\(/);
  assert.match(source, /async publishSchedule\(/);
  assert.match(source, /declineReason\?: string/);
  assert.match(source, /decline_reason: declineReason \?\? null/);
  assert.match(source, /MyDriverAssignment/);
  assert.match(source, /status: "published"/);
  assert.match(source, /published_at/);
});

test("Exchange 6 HomeScreen shows real assignments with confirm-all flow", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="home-screen"/);
  assert.match(source, /data-testid="confirm-drives"/);
  assert.match(source, /myAssignments/);
  assert.match(source, /MyDriverAssignment/);
  assert.match(source, /Confirm all drives/);
  assert.match(source, /No schedule yet/);
  assert.match(source, /assignmentsLoading/);
});

test("Exchange 6 ReviewScreen has per-assignment confirm and decline with reason", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="review-screen"/);
  assert.match(source, /data-testid="decline-form"/);
  assert.match(source, /Reason \(optional\)/);
  assert.match(source, /Confirm this drive/);
  assert.match(source, /make this one/);
  assert.match(source, /Confirm decline/);
  assert.match(source, /declineReason/);
});

test("Exchange 6 CoordinatorScreen has publish control", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="publish-schedule"/);
  assert.match(source, /Publish schedule/);
  assert.match(source, /scheduleStatus/);
  assert.match(source, /Schedule published/);
  assert.match(source, /publishing/);
});

test("Exchange 6 WeekScreen distinguishes draft from published", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /schedule-badge--draft/);
  assert.match(source, /schedule-badge--published/);
  assert.match(source, /isPublished/);
  assert.match(source, /status === "published"/);
});

test("Exchange 6 introduces no service-role or secret browser values", async () => {
  const envExample = await readFile(envExampleUrl, "utf8");

  assert.doesNotMatch(envExample, /^VITE_.*(?:SERVICE|SECRET)/m);
});