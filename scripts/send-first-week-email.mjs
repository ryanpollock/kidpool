#!/usr/bin/env node
// One-off: send the "first week of school" email to a single address.
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const args = process.argv.slice(2);
const sendAll = args.includes("--send-all");
const TO_EMAIL = sendAll ? null : (args.find((a) => !a.startsWith("--")) || "ryan.pollock@gmail.com");

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

const SUBJECT = "Carpool Crew — first week of school starts Monday! Here's what to do.";

const HTML_BODY = `
<h1 style="font-size:22px;margin:0 0 16px;">School starts Monday — here's what to do</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">The carpool app is ready to go. A few quick things to do before Saturday so the schedule comes together on time.</p>

<h2 style="font-size:16px;margin:24px 0 8px;">What you need to do this week</h2>

<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>1. Sign in</strong> at <a href="https://carpoolcrew.co">carpoolcrew.co</a> with your Google account. If it's your first time, you'll walk through a quick setup — your name, your kids, and your vehicle (if you have one).</p>

<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>2. Upload your photo</strong> (Account tab → tap the avatar circle). Other parents see this in the directory and on drive rosters — it helps everyone put a face to a name at pickup.</p>

<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>3. Add your kid's phone number</strong> if they have one (Account tab → tap your child). This is optional. If you add it, only the driver assigned to your child's ride sees it — a "Call [kid's first name]" button appears on their drive detail screen so they can reach your child directly if needed.</p>

<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>4. Set a buddy preference</strong> if your child has a friend they'd like to ride with (Account tab → tap your child → "Preferred buddy"). The scheduler tries to place buddies in the same car when possible.</p>

<h2 style="font-size:16px;margin:24px 0 8px;">Every week, the rhythm is</h2>
<table style="font-size:15px;line-height:1.6;border-collapse:collapse;margin:0 0 16px;">
<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;"><strong>By Saturday midnight</strong></td><td>Check in — open the Plan tab, mark which days your kid needs a ride and whether you can drive</td></tr>
<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;"><strong>Saturday afternoon</strong></td><td>Draft schedule is generated</td></tr>
<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;"><strong>By Sunday 7 PM</strong></td><td>Confirm your drives — if you said you can drive, you'll get an assignment. Tap Confirm or Decline on the Home screen</td></tr>
<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;"><strong>Sunday 8 PM</strong></td><td>Final schedule is published — you'll get an email and see it in the app</td></tr>
<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;"><strong>Monday morning</strong></td><td>Open the app — it tells you who's driving, who's riding, and where to meet</td></tr>
</table>

<h2 style="font-size:16px;margin:24px 0 8px;">If something changes mid-week</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">If a driver cancels or a kid gets sick, the app shows alerts and lets another parent volunteer to cover. You'll see it on the Home screen.</p>

<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">If you have trouble signing in or using the app, just reply to this email or text me and I'll help.</p>

<p style="font-size:15px;line-height:1.6;margin:16px 0 0;">Let's get these kids to school!</p>
<p style="font-size:15px;line-height:1.6;margin:4px 0 0;"><strong>— Ryan</strong></p>
`;

const TEXT_BODY = `School starts Monday — here's what to do

The carpool app is ready to go. A few quick things to do before Saturday so the schedule comes together on time.

WHAT YOU NEED TO DO THIS WEEK

1. Sign in at carpoolcrew.co with your Google account. If it's your first time, you'll walk through a quick setup — your name, your kids, and your vehicle (if you have one).

2. Upload your photo (Account tab → tap the avatar circle). Other parents see this in the directory and on drive rosters — it helps everyone put a face to a name at pickup.

3. Add your kid's phone number if they have one (Account tab → tap your child). This is optional. If you add it, only the driver assigned to your child's ride sees it — a "Call [kid's first name]" button appears on their drive detail screen so they can reach your child directly if needed.

4. Set a buddy preference if your child has a friend they'd like to ride with (Account tab → tap your child → "Preferred buddy"). The scheduler tries to place buddies in the same car when possible.

EVERY WEEK, THE RHYTHM IS

By Saturday midnight  — Check in: open the Plan tab, mark which days your kid needs a ride and whether you can drive
Saturday afternoon   — Draft schedule is generated
By Sunday 7 PM       — Confirm your drives: if you said you can drive, you'll get an assignment. Tap Confirm or Decline on the Home screen
Sunday 8 PM          — Final schedule is published — you'll get an email and see it in the app
Monday morning       — Open the app — it tells you who's driving, who's riding, and where to meet

IF SOMETHING CHANGES MID-WEEK

If a driver cancels or a kid gets sick, the app shows alerts and lets another parent volunteer to cover. You'll see it on the Home screen.

If you have trouble signing in or using the app, just reply to this email or text me and I'll help.

Let's get these kids to school!

— Ryan`;

async function main() {
  if (sendAll) {
    console.log("  WARNING: Sending to ALL production families");
    console.log("  This cannot be undone. Press Ctrl+C within 5 seconds to cancel...");
    await new Promise((r) => setTimeout(r, 5000));
    console.log("  Proceeding with send-all...\n");
  } else {
    console.log(`Sending email to: ${TO_EMAIL}`);
  }
  console.log(`Subject: ${SUBJECT}`);
  console.log("");

  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  const payload = {
    type: "broadcast",
    broadcast_id: "first-week-school-2026-08-13",
    subject: SUBJECT,
    html_body: HTML_BODY,
    text_body: TEXT_BODY,
  };
  if (TO_EMAIL) payload.filter_email = TO_EMAIL;

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});