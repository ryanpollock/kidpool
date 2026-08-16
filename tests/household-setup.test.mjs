import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);
const envExampleUrl = new URL("../.env.example", import.meta.url);

test("Exchange 3 repository exposes household write methods for children and vehicles", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /async addChild\(/);
  assert.match(source, /async updateChild\(/);
  assert.match(source, /async deactivateChild\(/);
  assert.match(source, /async upsertVehicle\(/);
  assert.match(source, /async getHouseholdSetup\(/);
  assert.match(source, /from\("children"\)/);
  assert.match(source, /from\("vehicles"\)/);
  assert.match(source, /first_name/);
  assert.match(source, /last_name/);
  assert.match(source, /child_passenger_capacity/);
});

test("deactivateChild deletes the child's ride_requests so stale rows don't accumulate", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  // The deactivateChild method must delete ride_requests for the child.
  // Stale ride_requests from deactivated children are ignored by the
  // scheduler (children loaded with active=true), but leaving them in
  // the DB confuses reporting queries. RLS allows household members
  // to delete their own household's ride_requests.
  const deactivateBlock = source.match(
    /async deactivateChild\(childId: string\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(deactivateBlock, "deactivateChild method should exist");
  assert.match(
    deactivateBlock[0],
    /from\("ride_requests"\)\s*\n\s*\.delete\(\)\s*\n\s*\.eq\("child_id", childId\)/,
    "deactivateChild should delete ride_requests by child_id",
  );
});

test("Exchange 3 account screen renders editable name, children, and vehicle sections", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="account-screen"/);
  assert.match(source, /data-testid="child-list"/);
  assert.match(source, /data-testid="add-child-form"/);
  assert.match(source, /data-testid="vehicle-form"/);
  assert.match(source, /Your name/);
  assert.match(source, /Children/);
  assert.match(source, /Vehicle/);
  assert.match(source, /Add child/);
  assert.match(source, /Passenger seats/);
  assert.match(source, /Includes your children when riding/);
  assert.match(source, /getHouseholdSetup/);
  assert.match(source, /HouseholdSetup/);
});

test("Exchange 3 plan screen reflects real household data with safe fallbacks", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /setup: HouseholdSetup \| null/);
  assert.match(source, /No vehicle/);
  assert.match(source, /Add one in your account/);
  assert.match(source, /setup\?\.children/);
  assert.match(source, /setup\?\.vehicles\.find/);
});

test("Exchange 3 introduces no service-role or secret browser values", async () => {
  const envExample = await readFile(envExampleUrl, "utf8");

  assert.doesNotMatch(envExample, /^VITE_.*(?:SERVICE|SECRET)/m);
});