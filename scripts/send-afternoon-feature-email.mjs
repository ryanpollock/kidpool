#!/usr/bin/env node
// One-off: send the "New: 4:20 PM afternoon pickup option" announcement.
//
// Usage:
//   node scripts/send-afternoon-feature-email.mjs                        # send to ryan.pollock@gmail.com (default)
//   node scripts/send-afternoon-feature-email.mjs --only <email>          # send to a specific address
//   node scripts/send-afternoon-feature-email.mjs --send-all             # send to ALL production families
//
// Requires: Supabase CLI linked to production (npm run link:prod).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || PRODUCTION_REF;

if (PROJECT_REF !== PRODUCTION_REF) {
  console.error(`Aborting: send-afternoon-feature-email targets production only. Linked to ${PROJECT_REF}.`);
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
const sendAll = args.includes("--send-all");
const onlyIndex = args.indexOf("--only");
const TO_EMAIL = onlyIndex >= 0 ? args[onlyIndex + 1] : "ryan.pollock@gmail.com";

const BROADCAST_ID = "afternoon-feature-2026-08-22";
const SUBJECT = "New: 4:20 PM afternoon pickup option";

const HTML_BODY = `
<h1 style="font-size:22px;margin:0 0 16px;">New afternoon pickup option</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">We have added a 4:20 PM afternoon pickup alongside the existing 5:15 PM. Families can now choose between two afternoon drive times &mdash; or select &ldquo;Either is fine&rdquo; and let the scheduler assign their child to whichever trip has room.</p>

<h2 style="font-size:16px;margin:24px 0 8px;">What is new</h2>
<ul style="font-size:15px;line-height:1.6;margin:0 0 8px;padding-left:20px;">
<li>Two afternoon options: 4:20 PM and 5:15 PM pickup from Presidio</li>
<li>&ldquo;Either is fine&rdquo;: If both times work, the scheduler tries 4:20 first and falls back to 5:15 if that trip is full</li>
<li>Independent driving preferences: Parents can volunteer to drive 4:20, 5:15, or both &mdash; separately</li>
<li>Standard week defaults: The Account screen now has 3 columns (AM, 4:20 PM, 5:15 PM) for setting recurring defaults</li>
</ul>

<h2 style="font-size:16px;margin:24px 0 8px;">What stays the same</h2>
<ul style="font-size:15px;line-height:1.6;margin:0 0 8px;padding-left:20px;">
<li>Morning pickup is unchanged (8:40 AM from Midtown Terrace)</li>
<li>Existing weeks keep their 2 trips/day &mdash; no change to live schedules</li>
<li>New weeks created from now on will have 3 trips/day</li>
<li>Your existing standard-week defaults carry over (set to 5:15 PM) until you edit them</li>
</ul>

<h2 style="font-size:16px;margin:24px 0 8px;">What to do</h2>
<ul style="font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:20px;">
<li>Open the app and go to <strong>Account &rarr; Standard Week</strong></li>
<li>Review your family afternoon preferences &mdash; update to 4:20, 5:15, or &ldquo;Either&rdquo; for each day</li>
<li>Update your driving availability for the 4:20 PM slot if you can drive it</li>
<li>When you check in for next week, you will see the new time picker for afternoons</li>
</ul>
`;

const TEXT_BODY = `New: 4:20 PM afternoon pickup option

New afternoon pickup option

We have added a 4:20 PM afternoon pickup alongside the existing 5:15 PM. Families can now choose between two afternoon drive times — or select "Either is fine" and let the scheduler assign their child to whichever trip has room.

WHAT IS NEW

- Two afternoon options: 4:20 PM and 5:15 PM pickup from Presidio
- "Either is fine": If both times work, the scheduler tries 4:20 first and falls back to 5:15 if that trip is full
- Independent driving preferences: Parents can volunteer to drive 4:20, 5:15, or both — separately
- Standard week defaults: The Account screen now has 3 columns (AM, 4:20 PM, 5:15 PM) for setting recurring defaults

WHAT STAYS THE SAME

- Morning pickup is unchanged (8:40 AM from Midtown Terrace)
- Existing weeks keep their 2 trips/day — no change to live schedules
- New weeks created from now on will have 3 trips/day
- Your existing standard-week defaults carry over (set to 5:15 PM) until you edit them

WHAT TO DO

- Open the app and go to Account -> Standard Week
- Review your family afternoon preferences — update to 4:20, 5:15, or "Either" for each day
- Update your driving availability for the 4:20 PM slot if you can drive it
- When you check in for next week, you will see the new time picker for afternoons`;

async function main() {
  console.log("\n  send-afternoon-feature-email\n");
  console.log(`  broadcast_id: ${BROADCAST_ID}`);
  console.log(`  subject:      ${SUBJECT}`);
  if (sendAll) {
    console.log(`  mode:         SEND TO ALL PRODUCTION FAMILIES`);
    console.log("  WARNING: This cannot be undone. Ctrl+C within 5 seconds to cancel...");
    await new Promise((r) => setTimeout(r, 5000));
    console.log("  Proceeding...\n");
  } else {
    console.log(`  recipient:    ${TO_EMAIL}`);
  }
  console.log("");

  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  const payload = {
    type: "broadcast",
    broadcast_id: BROADCAST_ID,
    subject: SUBJECT,
    html_body: HTML_BODY,
    text_body: TEXT_BODY,
  };
  if (!sendAll) payload.filter_email = TO_EMAIL;

  const body = JSON.stringify(payload);

  const url = `https://${PRODUCTION_REF}.supabase.co/functions/v1/send-push`;
  console.log(`POSTing to ${url}...`);

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
  console.log("Result:");
  console.log(JSON.stringify(result, null, 2));
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});