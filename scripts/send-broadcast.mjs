#!/usr/bin/env node
// Send a broadcast email to all production families.
//
// Usage:
//   node scripts/send-broadcast.mjs                  # dry-run (prints recipients)
//   node scripts/send-broadcast.mjs --send           # send to everyone
//   node scripts/send-broadcast.mjs --send --only ryan.pollock@gmail.com  # send to one
//
// Requires: Supabase CLI linked to production (npm run link:prod).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || PRODUCTION_REF;

if (PROJECT_REF !== PRODUCTION_REF) {
  console.error(`Aborting: send-broadcast targets production only. Linked to ${PROJECT_REF}.`);
  process.exit(1);
}

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp/project-ref"), "utf8").trim();
    if (linkedRef !== PRODUCTION_REF) {
      console.error(`CLI linked to ${linkedRef} but production ref is ${PRODUCTION_REF}. Run "npm run link:prod".`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref. Run 'npm run link:prod'.");
    process.exit(1);
  }
}
verifyLinkedProject();

// Resolve cron_secret from the production vault
function getCronSecret() {
  const tmpFile = path.join(import.meta.dirname, "..", "supabase/.temp", `_vault_${Date.now()}.sql`);
  writeFileSync(tmpFile, "select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret';");
  try {
    const result = execSync(`supabase db query --linked -f "${tmpFile}" 2>/dev/null`, { encoding: "utf8" });
    const parsed = JSON.parse(result);
    return parsed.rows[0].decrypted_secret;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

const args = process.argv.slice(2);
const shouldSend = args.includes("--send");
const onlyIndex = args.indexOf("--only");
const filterEmail = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

const BROADCAST_ID = "photos-2026-08-16";
const SUBJECT = "A quick request: add your photos to Carpool Crew";

const HTML_BODY = `
<h1 style="font-size:22px;margin:0 0 16px;">A quick request: add your photos</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Photos help keep everyone safe at pickup. When a driver opens the app to see who they're picking up, a photo makes it easy to recognize the right kid out of a crowd. And when a nervous child is getting into a car, a photo of the driver helps them feel comfortable knowing it's the right parent.</p>

<h2 style="font-size:16px;margin:24px 0 8px;">Two quick uploads:</h2>

<h2 style="font-size:15px;margin:16px 0 4px;">1. Your photo</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Tap your avatar (top-right) &rarr; <strong>Account</strong> &rarr; tap your name &rarr; upload a photo. If you're using a Google default (just a letter), please add a real photo so other parents and kids can recognize you at pickup.</p>

<h2 style="font-size:15px;margin:16px 0 4px;">2. Your child's photo</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>Account</strong> &rarr; <strong>Children</strong> section &rarr; tap your child's name &rarr; upload a photo. This is the photo drivers see when they open a drive to see who they're picking up.</p>

<p style="font-size:13px;color:#4f6278;margin:0 0 16px;">Takes 30 seconds and makes a real difference for every driver and kid in the carpool.</p>
`;

const TEXT_BODY = `A quick request: add your photos

Photos help keep everyone safe at pickup. When a driver opens the app to see who they're picking up, a photo makes it easy to recognize the right kid out of a crowd. And when a nervous child is getting into a car, a photo of the driver helps them feel comfortable knowing it's the right parent.

Two quick uploads:

1. YOUR PHOTO
Tap your avatar (top-right) -> Account -> tap your name -> upload a photo. If you're using a Google default (just a letter), please add a real photo so other parents and kids can recognize you at pickup.

2. YOUR CHILD'S PHOTO
Account -> Children section -> tap your child's name -> upload a photo. This is the photo drivers see when they open a drive to see who they're picking up.

Takes 30 seconds and makes a real difference for every driver and kid in the carpool.`;

async function main() {
  console.log("\n  send-broadcast\n");
  console.log(`  broadcast_id: ${BROADCAST_ID}`);
  console.log(`  subject:      ${SUBJECT}`);
  console.log(`  filter_email: ${filterEmail ?? "(none — all families)"}`);
  console.log(`  mode:         ${shouldSend ? "SEND" : "DRY RUN"}`);
  console.log("");

  if (!shouldSend) {
    console.log("  Dry run — pass --send to actually send.");
    console.log("  Pass --only <email> to send to one person.");
    return;
  }

  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  const body = JSON.stringify({
    type: "broadcast",
    broadcast_id: BROADCAST_ID,
    subject: SUBJECT,
    html_body: HTML_BODY,
    text_body: TEXT_BODY,
    filter_email: filterEmail,
  });

  const url = `https://${PRODUCTION_REF}.supabase.co/functions/v1/send-push`;
  console.log(`  POSTing to ${url}...`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body,
  });

  const result = await resp.json();
  console.log("");
  console.log("  Result:");
  console.log(JSON.stringify(result, null, 2));
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});