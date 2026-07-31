import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);

test("Exchange 2 protects the app behind persistent Google authentication", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /auth\.getSession\(\)/);
  assert.match(source, /auth\.onAuthStateChange/);
  assert.match(source, /signInWithOAuth\(\{[\s\S]*provider: "google"/);
  assert.match(source, /auth\.signOut\(\)/);
  assert.match(source, /Sign out and use a different Google account/);
  assert.match(source, /data-testid="sign-in-screen"/);
  assert.match(source, /data-testid="onboarding-screen"/);
  assert.match(source, /if \(!session\)/);
});

test("Exchange 2 onboarding keeps adults distinct and supports create or join", async () => {
  const source = await readFile(prototypeUrl, "utf8");
  const repository = await readFile(repositoryUrl, "utf8");

  assert.match(source, /Your full name/);
  assert.match(source, /Create my household/);
  assert.match(source, /Join my household/);
  assert.match(source, /Household join code/);
  assert.match(repository, /updateCurrentProfile\(fullName: string\)/);
  assert.match(repository, /rpc\("create_household_with_membership"/);
  assert.match(repository, /rpc\("join_household_by_code"/);
});
