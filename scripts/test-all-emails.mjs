#!/usr/bin/env node
// Send a test of every email type to a single address.
//
// Usage:
//   node scripts/test-all-emails.mjs                  # dry-run (prints what would send)
//   node scripts/test-all-emails.mjs --send           # send all to ryan.pollock@gmail.com
//   node scripts/test-all-emails.mjs --send --only <email>  # send to a different address
//
// Requires: Supabase CLI linked to production (npm run link:prod).

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || PRODUCTION_REF;

if (PROJECT_REF !== PRODUCTION_REF) {
  console.error(`Aborting: test-all-emails targets production only. Linked to ${PROJECT_REF}.`);
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

import { readFileSync } from "node:fs";
verifyLinkedProject();

// ── Resolve cron_secret ────────────────────────────────────────
function getCronSecret() {
  const tmpFile = path.join(import.meta.dirname, "..", "supabase/.temp", `_vault_test_${Date.now()}.sql`);
  writeFileSync(tmpFile, "select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret';");
  try {
    const result = execSync(`supabase db query --linked -f "${tmpFile}" 2>/dev/null`, { encoding: "utf8" });
    return JSON.parse(result).rows[0].decrypted_secret;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

const args = process.argv.slice(2);
const shouldSend = args.includes("--send");
const onlyIndex = args.indexOf("--only");
const recipient = onlyIndex >= 0 ? args[onlyIndex + 1] : "ryan.pollock@gmail.com";
const baseUrl = `https://${PRODUCTION_REF}.supabase.co/functions/v1`;

// ── Email type definitions ─────────────────────────────────────
// Each entry: { id, subject, html_body, text_body, description, send_via }
// send_via: "welcome" = trigger the welcome code path directly
//           "broadcast" = send via the broadcast type with the content

const emailTypes = [
  {
    id: "welcome",
    subject: "Welcome to Carpool Crew",
    description: "Onboarding email sent when a parent signs up for the first time. Explains the three tabs, weekly check-in, standard week, and app installation.",
    send_via: "welcome",
  },
  {
    id: "drive_confirmed",
    subject: "You're driving morning — calendar invite",
    description: "Sent immediately after a driver confirms a drive. Email with a .ics calendar invite attached (1-hour event: 15 min before pickup through 45 min after departure). Includes Google Calendar link as fallback.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:22px;margin:0 0 16px;">You're driving, Ryan</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Your morning drive is confirmed for 2026-08-14. Meet at Midtown Terrace Playground at 8:40 AM. Depart 8:45 AM. Kids in your car: Sara Pollock, Lily Chen.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">A calendar invite is attached to this email. Open it to add the event to your calendar — it covers the full drive (15 min before pickup through 45 min after departure).</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 16px;">Or add via <a href="https://calendar.google.com">Google Calendar</a>.</p>`,
    text_body: `You're driving, Ryan

Your morning drive is confirmed for 2026-08-14. Meet at Midtown Terrace Playground at 8:40 AM. Depart 8:45 AM. Kids in your car: Sara Pollock, Lily Chen.

A calendar invite is attached to this email. Open it to add the event to your calendar — it covers the full drive (15 min before pickup through 45 min after departure).`,
  },
  {
    id: "night_before_summary",
    subject: "Tomorrow's carpool",
    description: "Sent at 9 PM Pacific every night before a school day. Personalized: shows the recipient's driving status + the full driver roster with kids in each car.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:22px;margin:0 0 16px;">Tomorrow's carpool, Ryan</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">You're driving tomorrow morning — 8:40 AM from Midtown Terrace Playground. Kids in your car: Sara Pollock, Lily Chen.</p>
<h2 style="font-size:16px;margin:24px 0 8px;">Tomorrow's drivers</h2>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Morning (8:40 AM from Midtown Terrace Playground): Ryan Pollock (Silver Honda) — Sara Pollock, Lily Chen; Justin Mikecz (Blue Subaru) — Max Chen, Emma Johnson
Afternoon (5:15 PM from Presidio Middle School): Yvonne Ou (Green Volvo) — Sara Pollock, Lily Chen; Jessica Archer Nuzzo (Red Toyota) — Max Chen</p>`,
    text_body: `Tomorrow's carpool, Ryan

You're driving tomorrow morning — 8:40 AM from Midtown Terrace Playground. Kids in your car: Sara Pollock, Lily Chen.

Tomorrow's drivers
Morning (8:40 AM from Midtown Terrace Playground): Ryan Pollock (Silver Honda) — Sara Pollock, Lily Chen; Justin Mikecz (Blue Subaru) — Max Chen, Emma Johnson
Afternoon (5:15 PM from Presidio Middle School): Yvonne Ou (Green Volvo) — Sara Pollock, Lily Chen; Jessica Archer Nuzzo (Red Toyota) — Max Chen`,
  },
  {
    id: "drive_reminder",
    subject: "Drive in 75 minutes",
    description: "Sent 75 minutes before a confirmed driver's pickup time. Push + email listing the kids in their car.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">Your morning drive starts at 8:40 AM from Midtown Terrace Playground. Kids in your car: Sara Pollock, Lily Chen.</p>`,
    text_body: `Your morning drive starts at 8:40 AM from Midtown Terrace Playground. Kids in your car: Sara Pollock, Lily Chen.`,
  },
  {
    id: "published",
    subject: "Schedule published",
    description: "Sent to all members when the weekly schedule is auto-published (Sunday 8:30 PM Pacific) or manually published by the coordinator.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">The schedule for this week has been published. Open the app to see your drives.</p>`,
    text_body: `The schedule for this week has been published. Open the app to see your drives.`,
  },
  {
    id: "declined",
    subject: "Drive cancelled",
    description: "Sent to families whose child was in a car when the driver declined. Tells them their child needs a new ride.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">Justin Mikecz declined the morning trip on 2026-08-14. Your child needs a new ride.</p>`,
    text_body: `Justin Mikecz declined the morning trip on 2026-08-14. Your child needs a new ride.`,
  },
  {
    id: "uncovered",
    subject: "Ride needed",
    description: "Sent to families whose child has no ride assigned after the schedule is published.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">Your child doesn't have a ride assigned for this week. Check the schedule or contact the admin.</p>`,
    text_body: `Your child doesn't have a ride assigned for this week. Check the schedule or contact the admin.`,
  },
  {
    id: "volunteered",
    subject: "Drive covered",
    description: "Sent to families whose child was uncovered when a volunteer driver covers the trip.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">A driver has covered the morning trip on 2026-08-14 for your child.</p>`,
    text_body: `A driver has covered the morning trip on 2026-08-14 for your child.`,
  },
  {
    id: "manually_assigned",
    subject: "You've been assigned",
    description: "Sent to a driver when the coordinator manually assigns them to an uncovered trip.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">The coordinator assigned you to drive the afternoon trip on 2026-08-14. Open the app to confirm.</p>`,
    text_body: `The coordinator assigned you to drive the afternoon trip on 2026-08-14. Open the app to confirm.`,
  },
  {
    id: "admin_escalation",
    subject: "Schedule needs attention",
    description: "Sent to coordinators only when there are uncovered children after the schedule is published.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">2 children still need a ride this week. Open the app to assign a driver.</p>`,
    text_body: `2 children still need a ride this week. Open the app to assign a driver.`,
  },
  {
    id: "displaced",
    subject: "You're no longer driving",
    description: "Sent to a driver when schedule re-optimization removes them from a trip they were previously assigned to.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">The afternoon trip on 2026-08-14 was re-optimized — you're no longer needed as a driver. Thanks for being available.</p>`,
    text_body: `The afternoon trip on 2026-08-14 was re-optimized — you're no longer needed as a driver. Thanks for being available.`,
  },
  {
    id: "deadline_reminder",
    subject: "Check-in deadline",
    description: "Sent to families who haven't submitted their weekly check-in when the deadline (Saturday 3 PM Pacific) is approaching.",
    send_via: "broadcast",
    html_body: `
<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>
<p style="font-size:15px;color:#0c2b52;line-height:1.5;">Your check-in deadline is approaching. Submit your ride needs soon.</p>`,
    text_body: `Your check-in deadline is approaching. Submit your ride needs soon.`,
  },
];

async function main() {
  console.log("\n  test-all-emails\n");
  console.log(`  recipient: ${recipient}`);
  console.log(`  mode:      ${shouldSend ? "SEND" : "DRY RUN"}`);
  console.log(`  emails:    ${emailTypes.length}`);
  console.log("");

  if (!shouldSend) {
    console.log("  Dry run — pass --send to actually send.\n");
    for (const e of emailTypes) {
      console.log(`  [${e.id}] "${e.subject}"`);
      console.log(`    ${e.description}`);
      console.log("");
    }
    return;
  }

  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  let sent = 0;
  let failed = 0;

  for (const e of emailTypes) {
    const broadcastId = `test-all-emails-${e.id}-${Date.now()}`;
    console.log(`  [${e.id}] "${e.subject}"...`);

    try {
      let resp;
      if (e.send_via === "welcome") {
        // Trigger the welcome code path directly — it accepts body params
        resp = await fetch(`${baseUrl}/send-push`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${cronSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "welcome",
            email: recipient,
            full_name: "Ryan Pollock",
            user_id: `test-all-emails-${Date.now()}`,
          }),
        });
      } else {
        // Send via broadcast with the actual content + filter to just this email
        resp = await fetch(`${baseUrl}/send-push`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${cronSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "broadcast",
            broadcast_id: broadcastId,
            subject: e.subject,
            html_body: e.html_body,
            text_body: e.text_body,
            filter_email: recipient,
          }),
        });
      }

      const result = await resp.json();
      if (result.email_sent > 0 || (e.send_via === "welcome" && result.email_sent > 0)) {
        console.log(`    -> sent (email_sent=${result.email_sent})`);
        sent++;
      } else if (result.skipped) {
        console.log(`    -> skipped (test email filter)`);
      } else {
        console.log(`    -> ${JSON.stringify(result)}`);
        if (result.email_failed > 0) failed++;
      }
    } catch (err) {
      console.error(`    -> FAILED: ${err.message}`);
      failed++;
    }

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n  Done: ${sent} sent, ${failed} failed\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});