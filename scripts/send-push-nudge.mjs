#!/usr/bin/env node
// One-off: send a "get push notifications" nudge to parents who haven't opted in.
//
// Usage:
//   node scripts/send-push-nudge.mjs --only ryan.pollock@gmail.com   # test send
//   node scripts/send-push-nudge.mjs --send                         # send to all 10
//
// Requires: Supabase CLI linked to production (npm run link:prod).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || PRODUCTION_REF;

if (PROJECT_REF !== PRODUCTION_REF) {
  console.error(`Aborting: send-push-nudge targets production only. Linked to ${PROJECT_REF}.`);
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
const shouldSend = args.includes("--send");
const onlyIndex = args.indexOf("--only");
const testEmail = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

const BROADCAST_ID = "push-nudge-2026-08-23";
const SUBJECT = "Get push notifications from Carpool Crew";

const HTML_BODY = `
<h1 style="font-size:22px;margin:0 0 16px;">You're missing real-time alerts</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Push notifications tell you when your child's drive is confirmed, cancelled, or reassigned, and remind you when it's your turn to drive. Right now you're only getting emails &mdash; push is faster and harder to miss.</p>

<h2 style="font-size:16px;margin:24px 0 8px;">iPhone users</h2>
<ol style="font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:20px;">
<li>Open <a href="https://carpoolcrew.co">carpoolcrew.co</a> in <strong>Safari</strong> (not Chrome)</li>
<li>Tap the <strong>Share</strong> button (square with up arrow, at the bottom of the screen)</li>
<li>Tap <strong>&ldquo;Add to Home Screen&rdquo;</strong></li>
<li>Open Carpool Crew from your home screen (not from Safari)</li>
<li>When asked, tap <strong>&ldquo;Allow&rdquo;</strong> to enable notifications</li>
</ol>

<h2 style="font-size:16px;margin:24px 0 8px;">Android users</h2>
<ol style="font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:20px;">
<li>Open <a href="https://carpoolcrew.co">carpoolcrew.co</a> in Chrome</li>
<li>When prompted, tap <strong>&ldquo;Allow&rdquo;</strong> to enable notifications</li>
<li>For the best experience, tap <strong>&ldquo;Install app&rdquo;</strong> or <strong>&ldquo;Add to Home screen&rdquo;</strong> when prompted</li>
</ol>

<p style="font-size:15px;line-height:1.6;margin:16px 0 0;">That's it. You'll start getting instant alerts when drives change, schedules are published, and it's time to confirm your rides.</p>
<p style="font-size:15px;line-height:1.6;margin:16px 0 0;">&mdash; Ryan</p>
`;

const TEXT_BODY = `Get push notifications from Carpool Crew

You're missing real-time alerts. Push notifications tell you when your child's drive is confirmed, cancelled, or reassigned, and remind you when it's your turn to drive. Right now you're only getting emails — push is faster and harder to miss.

IPHONE USERS

1. Open carpoolcrew.co in Safari (not Chrome)
2. Tap the Share button (square with up arrow, at the bottom of the screen)
3. Tap "Add to Home Screen"
4. Open Carpool Crew from your home screen (not from Safari)
5. When asked, tap "Allow" to enable notifications

ANDROID USERS

1. Open carpoolcrew.co in Chrome
2. When prompted, tap "Allow" to enable notifications
3. For the best experience, tap "Install app" or "Add to Home screen" when prompted

That's it. You'll start getting instant alerts when drives change, schedules are published, and it's time to confirm your rides.

— Ryan`;

const RECIPIENTS = [
  "aaronvisse@gmail.com",
  "tibugizer@gmail.com",
  "dkiziryan@gmail.com",
  "felicedunn@gmail.com",
  "huatchye@gmail.com",
  "jessica@truthloveyoga.com",
  "undergroundbee26@gmail.com",
  "sstofferahn@gmail.com",
  "tiffnyc@gmail.com",
  "tolgaurhan@gmail.com",
];

async function sendToRecipient(cronSecret, email) {
  const payload = {
    type: "broadcast",
    broadcast_id: BROADCAST_ID,
    subject: SUBJECT,
    html_body: HTML_BODY,
    text_body: TEXT_BODY,
    filter_email: email,
  };

  const url = `https://${PRODUCTION_REF}.supabase.co/functions/v1/send-push`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await resp.json();
  return result;
}

async function main() {
  console.log("\n  send-push-nudge\n");
  console.log(`  broadcast_id: ${BROADCAST_ID}`);
  console.log(`  subject:      ${SUBJECT}`);

  if (testEmail) {
    console.log(`  test send to: ${testEmail}`);
  } else if (!shouldSend) {
    console.log(`\n  Dry run — ${RECIPIENTS.length} recipients:`);
    for (const e of RECIPIENTS) console.log(`    ${e}`);
    console.log("\n  Pass --send to actually send.");
    return;
  } else {
    console.log(`  sending to: ${RECIPIENTS.length} parents`);
  }
  console.log("");

  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  const sendList = testEmail ? [testEmail] : RECIPIENTS;

  for (const email of sendList) {
    console.log(`  Sending to ${email}...`);
    const result = await sendToRecipient(cronSecret, email);
    console.log(`    email_sent: ${result.email_sent}, email_failed: ${result.email_failed}`);
  }
  console.log("\n  Done.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});