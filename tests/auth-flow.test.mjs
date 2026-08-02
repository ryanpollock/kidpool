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
  assert.match(source, /signOut\(/);
  assert.match(source, /Sign out and use a different Google account/);
  assert.match(source, /data-testid="sign-in-screen"/);
  assert.match(source, /data-testid="onboarding-screen"/);
  assert.match(source, /if \(!session\)/);
});

test("signIn always uses Google OAuth, never testAuth", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  // Extract the signIn function body
  const signInMatch = source.match(/const signIn = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(signInMatch, "signIn function should exist");
  const signInBody = signInMatch[1];

  // signIn should call signInWithOAuth with Google
  assert.match(signInBody, /signInWithOAuth/);
  assert.match(signInBody, /provider: "google"/);

  // signIn should NOT check for testAuth (that's only in the getSession effect)
  assert.doesNotMatch(signInBody, /testAuth/);
  assert.doesNotMatch(signInBody, /signInWithPassword/);
});

test("signOut strips testAuth from URL and awaits the call", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  // Extract the signOut function body
  const signOutMatch = source.match(/const signOut = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(signOutMatch, "signOut function should exist");
  const signOutBody = signOutMatch[1];

  // signOut should strip testAuth from URL
  assert.match(signOutBody, /testAuth=/);
  assert.match(signOutBody, /replaceState/);

  // signOut should await the signOut call (not fire-and-forget)
  assert.match(signOutBody, /await supabase\.auth\.signOut/);

  // signOut should use scope: "local" (only signs out current device)
  assert.match(signOutBody, /scope:\s*"local"/);
});

test("getSession effect handles testAuth before session check", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  // The testAuth block should appear before the normal session return
  // Verify testAuth is checked inside the getSession .then() callback
  assert.match(source, /getSession\(\)\.then\(async/);

  // Verify it signs out existing user if switching demo accounts
  assert.match(source, /data\.session\.user\?\.email !== email/);
  assert.match(source, /signOut\(\{ scope: "local" \}\)/);

  // Verify it cleans the URL after testAuth sign-in
  assert.match(source, /replaceState\(\{\}, document\.title, window\.location\.pathname\)/);
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
