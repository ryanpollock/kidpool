#!/usr/bin/env node
// One-off: send a nudge email to households that did not submit check-ins
// for last week (the week starting Aug 17, 2026 — first week of school).
//
// Usage:
//   node scripts/send-non-submitter-nudge.mjs                        # dry-run (prints recipients)
//   node scripts/send-non-submitter-nudge.mjs --send                 # send to all non-submitters
//   node scripts/send-non-submitter-nudge.mjs --only ryan.pollock@gmail.com  # test send to one address
//
// Requires: Supabase CLI linked to production (npm run link:prod).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || PRODUCTION_REF;

if (PROJECT_REF !== PRODUCTION_REF) {
  console.error(`Aborting: send-non-submitter-nudge targets production only. Linked to ${PROJECT_REF}.`);
  process.exit(1);
}

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp", "project-ref"), "utf8").trim();
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

function getNonSubmitters() {
  const sql = `
    with target_week as (
      select id from public.weeks
      where group_id = 'c1000000-0000-4000-8000-000000000001'
        and starts_on = '2026-08-17'
    ),
    active_households as (
      select distinct m.household_id
      from public.memberships m
      where m.group_id = 'c1000000-0000-4000-8000-000000000001'
        and m.status = 'active'
    ),
    submitted as (
      select c.household_id
      from public.weekly_checkins c, target_week tw
      where c.week_id = tw.id
        and c.status = 'submitted'
    )
    select p.id as profile_id, p.full_name, p.email, h.name as household_name
    from active_households ah
    join public.memberships m on m.household_id = ah.household_id and m.status = 'active'
    join public.profiles p on p.id = m.profile_id
    join public.households h on h.id = ah.household_id
    where ah.household_id not in (select household_id from submitted)
    order by h.name, p.full_name;
  `;
  const tmpFile = path.join(import.meta.dirname, "..", "supabase/.temp", `_query_${Date.now()}.sql`);
  writeFileSync(tmpFile, sql);
  try {
    const result = execSync(`supabase db query --linked -f "${tmpFile}" 2>/dev/null`, { encoding: "utf8" });
    const parsed = JSON.parse(result);
    return parsed.rows;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

const args = process.argv.slice(2);
const shouldSend = args.includes("--send");
const onlyIndex = args.indexOf("--only");
const filterEmail = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

const BROADCAST_ID = "non-submitter-nudge-2026-08-22";
const SUBJECT = "The Carpool Crew wants you!";

const HTML_BODY = `
<h1 style="font-size:22px;margin:0 0 16px;">The Carpool Crew wants you!</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">The first week of Carpool Crew proved a success &mdash; parents are already saving more than two hours of driving.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">We want your kid to join the crew. It has been fun.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">The new hit song, <a href="https://suno.com/s/GQJoappVnuYaUo8Z" style="color:#118b8c;">&ldquo;Carpool Crew&rdquo; waits for no one</a>, has already gone viral at Presidio &mdash; or at least it soon will. So do yourself a favor and start using Carpool Crew this week.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">If you have any questions, hit me up on WhatsApp or text me at 650-743-7563.</p>
<p style="font-size:15px;line-height:1.6;margin:16px 0 0;">&mdash; Ryan</p>
`;

const TEXT_BODY = `The Carpool Crew wants you!

The first week of Carpool Crew proved a success — parents are already saving more than two hours of driving.

We want your kid to join the crew. It has been fun.

The new hit song, "Carpool Crew" waits for no one (https://suno.com/s/GQJoappVnuYaUo8Z), has already gone viral at Presidio — or at least it soon will. So do yourself a favor and start using Carpool Crew this week.

If you have any questions, hit me up on WhatsApp or text me at 650-743-7563.

— Ryan`;

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
  console.log("\n  send-non-submitter-nudge\n");
  console.log(`  broadcast_id: ${BROADCAST_ID}`);
  console.log(`  subject:      ${SUBJECT}`);
  console.log("");

  const recipients = getNonSubmitters();
  if (recipients.length === 0) {
    console.log("  No non-submitters found — all households checked in last week.");
    return;
  }

  console.log(`  Non-submitters (${recipients.length}):`);
  for (const r of recipients) {
    console.log(`    ${r.full_name} <${r.email}>  (${r.household_name})`);
  }
  console.log("");

  if (filterEmail) {
    console.log(`  Test mode: sending only to ${filterEmail}`);
  } else if (!shouldSend) {
    console.log("  Dry run — pass --send to actually send.");
    return;
  }

  const cronSecret = getCronSecret();
  if (!cronSecret) {
    console.error("Could not resolve cron_secret from vault.");
    process.exit(1);
  }

  const sendList = filterEmail ? [{ email: filterEmail, full_name: "Test", household_name: "test" }] : recipients;

  for (const r of sendList) {
    console.log(`  Sending to ${r.email}...`);
    const result = await sendToRecipient(cronSecret, r.email);
    console.log(`    email_sent: ${result.email_sent}, email_failed: ${result.email_failed}`);
  }
  console.log("\n  Done.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});