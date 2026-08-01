#!/usr/bin/env node
// Deploy the current branch to Vercel as a preview and alias it to kidpool-staging.vercel.app.
//
// Usage: npm run deploy:staging
// Run from the `staging` branch (or any branch) to update the public staging site.
// Uses Vercel Preview env vars (staging Supabase).

import { execSync } from "node:child_process";

const ALIAS = "kidpool-staging.vercel.app";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();
}

console.log("\n  Deploying to Vercel (preview)...\n");

// Deploy as preview (not production)
const output = run("vercel --yes 2>&1");
const match = output.match(/Deployment (https:\/\/[^\s]+) ready/);
if (!match) {
  console.error("  Could not parse deployment URL from Vercel output.");
  console.error(output);
  process.exit(1);
}
const deploymentUrl = match[1];
console.log(`  Deployment: ${deploymentUrl}`);

// Alias to stable staging URL
console.log(`  Aliasing to ${ALIAS}...`);
try {
  run(`vercel alias set ${deploymentUrl} ${ALIAS} 2>&1`);
  console.log(`  ✓ Staging site live at https://${ALIAS}\n`);
} catch (e) {
  console.error(`  Failed to set alias: ${e.message}`);
  process.exit(1);
}