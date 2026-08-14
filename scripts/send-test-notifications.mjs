#!/usr/bin/env node
// Send test notifications to a single address so you can see what each
// notification type looks like (email + push).
//
// Usage: node scripts/send-test-notifications.mjs ryan.pollock@gmail.com

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const TO_EMAIL = process.argv[2] || "ryan.pollock@gmail.com";

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

const notifications = [
  {
    subject: "Check in for next week — deadline Saturday midnight",
    html: `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1><p style="font-size:15px;color:#0c2b52;line-height:1.5;">Check in for next week — deadline Saturday midnight.</p><p style="margin-top:24px;"><a href="https://carpoolcrew.co" style="display:inline-block;background:#118b8c;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:15px;">Open the app</a></p>`,
    text: "Check in for next week — deadline Saturday midnight.",
  },
  {
    subject: "You're requested to drive 2 trips",
    html: `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1><p style="font-size:15px;color:#0c2b52;line-height:1.5;">You're requested to drive 2 trips next week. Open the app to confirm by 7 PM tonight.</p><p style="margin-top:24px;"><a href="https://carpoolcrew.co" style="display:inline-block;background:#118b8c;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:15px;">Open the app</a></p>`,
    text: "You're requested to drive 2 trips next week. Open the app to confirm by 7 PM tonight.",
  },
  {
    subject: "1 hour left to confirm",
    html: `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1><p style="font-size:15px;color:#0c2b52;line-height:1.5;">Confirm your drives now — deadline in 1 hour.</p><p style="margin-top:24px;"><a href="https://carpoolcrew.co" style="display:inline-block;background:#118b8c;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:15px;">Open the app</a></p>`,
    text: "Confirm your drives now — deadline in 1 hour.",
  },
  {
    subject: "Missed check-in deadline",
    html: `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1><p style="font-size:15px;color:#0c2b52;line-height:1.5;">You missed the check-in deadline. Submit now — your kid may not get a spot unless you drive.</p><p style="margin-top:24px;"><a href="https://carpoolcrew.co" style="display:inline-block;background:#118b8c;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:15px;">Open the app</a></p>`,
    text: "You missed the check-in deadline. Submit now — your kid may not get a spot unless you drive.",
  },
];

async function main() {
  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  for (let i = 0; i < notifications.length; i++) {
    const n = notifications[i];
    console.log(`Sending ${i + 1}/${notifications.length}: ${n.subject}`);

    const body = JSON.stringify({
      type: "broadcast",
      broadcast_id: `test-notifications-${Date.now()}-${i}`,
      subject: n.subject,
      html_body: n.html,
      text_body: n.text,
      filter_email: TO_EMAIL,
    });

    const url = `https://${PRODUCTION_REF}.supabase.co/functions/v1/send-push`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body,
    });

    const result = await resp.json();
    console.log(`  → email_sent: ${result.email_sent}, sent: ${result.sent}`);

    // Wait 2 seconds between sends so they arrive in order
    if (i < notifications.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log("\nDone. Check your email and phone for 4 notifications.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});