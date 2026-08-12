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
import { readFileSync } from "node:fs";
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
  const { writeFileSync, unlinkSync } = await import("node:fs");
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

const BROADCAST_ID = "pwa-setup-2026-08-12";
const SUBJECT = "Set up notifications + check in for next week";

const HTML_BODY = `
<h1 style="font-size:22px;margin:0 0 16px;">Welcome to Carpool Crew</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">Three quick steps before school starts:</p>

<h2 style="font-size:16px;margin:24px 0 8px;">1. Install the app on your phone</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>iPhone:</strong> Open <a href="https://carpoolcrew.co">carpoolcrew.co</a> in Safari, tap the Share button, then <strong>Add to Home Screen</strong>. Launch the app from the home screen icon (not Safari) to get push notifications.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>Android:</strong> Open carpoolcrew.co in Chrome, tap the menu (three dots), then <strong>Add to Home Screen</strong> or <strong>Install app</strong>. Allow notifications when prompted.</p>

<h2 style="font-size:16px;margin:24px 0 8px;">2. Enable notifications</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Open the app from your home screen icon. Tap <strong>Allow</strong> on the "Get notified" banner at the top of the Home screen. You'll get alerts when:</p>
<ul style="font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:20px;">
  <li>Your child's drive changes</li>
  <li>It's 75 minutes before you drive</li>
  <li>The night before each school day (who's driving tomorrow)</li>
</ul>

<h2 style="font-size:16px;margin:24px 0 8px;">3. Check in for next week (Aug 17–21)</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Open the <strong>Next Week</strong> tab and tell us which days your child needs rides and which days you can drive. Tap <strong>Submit</strong> by <strong>Saturday, August 15 at 3 PM Pacific</strong>. Missed check-ins mean your child might not get a ride.</p>

<div style="background:#f0f9f9;border-left:4px solid #118b8c;padding:12px 16px;margin:16px 0;border-radius:4px;">
<p style="font-size:15px;line-height:1.6;margin:0;"><strong>Tip:</strong> Set your standard week (tap your avatar, then edit <strong>Standard week</strong>) to pre-fill your weekly check-in with your family's typical ride needs and driving availability. You still need to open the Next Week tab and tap Submit each week.</p>
</div>
`;

const TEXT_BODY = `Welcome to Carpool Crew

Three quick steps before school starts:

1. INSTALL THE APP ON YOUR PHONE

iPhone: Open carpoolcrew.co in Safari, tap the Share button, then "Add to Home Screen". Launch the app from the home screen icon (not Safari) to get push notifications.

Android: Open carpoolcrew.co in Chrome, tap the menu (three dots), then "Add to Home Screen" or "Install app". Allow notifications when prompted.

2. ENABLE NOTIFICATIONS

Open the app from your home screen icon. Tap "Allow" on the "Get notified" banner at the top of the Home screen. You'll get alerts when:
  - Your child's drive changes
  - It's 75 minutes before you drive
  - The night before each school day (who's driving tomorrow)

3. CHECK IN FOR NEXT WEEK (AUG 17-21)

Open the Next Week tab and tell us which days your child needs rides and which days you can drive. Tap Submit by Saturday, August 15 at 3 PM Pacific. Missed check-ins mean your child might not get a ride.

Tip: Set your standard week (tap your avatar, then edit "Standard week") to pre-fill your weekly check-in with your family's typical ride needs and driving availability. You still need to open the Next Week tab and tap Submit each week.`;

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