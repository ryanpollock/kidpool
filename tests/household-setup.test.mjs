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
  assert.match(source, /No vehicle set up/);
  assert.match(source, /Add a vehicle in your account/);
  assert.match(source, /setup\?\.children\.find/);
  assert.match(source, /setup\?\.vehicles\.find/);
});

test("Exchange 3 introduces no service-role or secret browser values", async () => {
  const envExample = await readFile(envExampleUrl, "utf8");

  assert.doesNotMatch(envExample, /^VITE_.*(?:SERVICE|SECRET)/m);
});