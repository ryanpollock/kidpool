#!/usr/bin/env node
// Crewmate AI — Phase 1 eval gate (CREWMATE_REQUIREMENTS.md §11).
//
// Two modes:
//
//   triage (default)  `node scripts/crewmate-eval.mjs`
//     Runs the labeled triage sample set through the triage model via the
//     Together API directly — no DB required. PASS = classification
//     accuracy >= threshold (default 0.85). This is the gate that must
//     pass before a group's crewmate_enabled flag turns on.
//
//   e2e               `node scripts/crewmate-eval.mjs --mode e2e`
//     Drives the FULL deployed pipeline on STAGING: signs in as a demo
//     parent, posts labeled messages into their private Crewmate thread
//     (plus chatter samples into the Everyone thread), polls for agent
//     replies, and grades: questions must get a reply, chatter must get
//     silence, replies must never claim to have changed the schedule.
//     Requires the migration applied, chat-agent deployed, TOGETHER_API_KEY
//     + CRON_SECRET set, and the pilot group's crewmate_enabled flag ON.
//
// The triage prompt here is a copy of the one in
// supabase/functions/chat-agent/index.ts — keep the two in sync (the
// contract test does not verify prompt parity; review manually).

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PRODUCTION_REF = "ujcrnrcgbvzyqosykkjy";
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "jfyjgmhqnlbdcafoarrg"; // Defaulting to staging
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const GROUP_ID = "c1000000-0000-4000-8000-000000000001";
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const TRIAGE_MODEL = process.env.CREWMATE_TRIAGE_MODEL || "zai-org/GLM-5.3-Flash";
const DEMO_EMAIL = process.env.CREWMATE_EVAL_USER || "chen@seed.kidpool";
const DEMO_PASSWORD = "SeedPass123!";

if (PROJECT_REF === PRODUCTION_REF) {
  console.error("Aborting: crewmate-eval must not run against production. Run `npm run link:test` first.");
  process.exit(1);
}

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const MODE = argValue("--mode") || "triage";
const THRESHOLD = Number(argValue("--threshold") ?? "0.85");

// ── Labeled sample sets ────────────────────────────────────────────
// Names use the seeded demo families (npm run seed-demo).

const TRIAGE_SAMPLES = [
  // questions
  { body: "Who is driving Wednesday morning?", expected: "question" },
  { body: "Is Friday afternoon covered?", expected: "question" },
  { body: "What time is pickup tomorrow?", expected: "question" },
  { body: "Which car is Ava in on Tuesday?", expected: "question" },
  { body: "Did the Johnsons confirm their drive?", expected: "question" },
  { body: "who's got Maya for the afternoon ride", expected: "question" },
  { body: "Are there any uncovered trips this week?", expected: "question" },
  { body: "What changed since last week's schedule?", expected: "question" },
  { body: "How many kids are in Finn's car Monday?", expected: "question" },
  { body: "When do we meet at Midtown Terrace?", expected: "question" },
  { body: "Is there an extra late pickup Thursday?", expected: "question" },
  { body: "Do the Andersons drive this week at all?", expected: "question" },
  { body: "Who has Max tomorrow morning?", expected: "question" },
  { body: "Are seats still open on the 4:50 pickup?", expected: "question" },
  { body: "What am I doing this week?", expected: "question" },
  { body: "Where does the morning car go from again?", expected: "question" },
  // actions (Phase 1: deferred, but still triaged as action)
  { body: "Take Zoe off Thursday's ride, we're away.", expected: "action" },
  { body: "I can't drive Tuesday morning anymore.", expected: "action" },
  { body: "Can you put Maya in Sofia's car instead?", expected: "action" },
  { body: "I'll cover the Wednesday drive if nobody has it.", expected: "action" },
  { body: "Switch Leo to the early pickup.", expected: "action" },
  { body: "We're away all next week — no rides needed.", expected: "action" },
  { body: "Add a 4:50 pickup Tuesday for the theater kids.", expected: "action" },
  { body: "I only have two seats this week, husband took the big car.", expected: "action" },
  // consent (Phase 1: point at the buttons, but triaged as consent)
  { body: "Yes, go ahead and cancel it.", expected: "consent" },
  { body: "Confirmed — that works for us.", expected: "consent" },
  { body: "No wait, don't do that one.", expected: "consent" },
  { body: "Yes please make the change.", expected: "consent" },
  // chatter — must stay silent
  { body: "Anyone else's kid obsessed with Bluey rn", expected: "chatter" },
  { body: "Great game last night!", expected: "chatter" },
  { body: "Happy birthday Priya!! 🎉", expected: "chatter" },
  { body: "lol Sean you beat me to it", expected: "chatter" },
  { body: "Thanks for the cookies, Lisa!", expected: "chatter" },
  { body: "See everyone at the potluck Saturday.", expected: "chatter" },
  { body: "Ugh, this traffic on 280 is brutal today.", expected: "chatter" },
  { body: "Who's going to the school auction Friday night?", expected: "chatter" },
];

// e2e samples: posted into the demo parent's PRIVATE Crewmate thread
// (always-answered) and the Everyone thread (triage-gated).
const E2E_SAMPLES = [
  { body: "Who is driving Wednesday morning?", thread: "agent", expectReply: true },
  { body: "Is Friday afternoon covered?", thread: "agent", expectReply: true },
  { body: "What time is pickup tomorrow?", thread: "agent", expectReply: true },
  { body: "Which car is Ava Williams in on Tuesday?", thread: "agent", expectReply: true },
  { body: "What am I doing this week?", thread: "agent", expectReply: true },
  { body: "Are there any uncovered trips this week?", thread: "agent", expectReply: true },
  { body: "Anyone else's kid obsessed with Bluey rn", thread: "everyone", expectReply: false },
  { body: "Great game last night!", thread: "everyone", expectReply: false },
];

// An agent reply must NEVER contain these (Phase 1: no changes, no
// fabricated confirmations).
const FORBIDDEN_IN_REPLY = [
  "i've cancelled", "i have cancelled", "i've removed", "i have removed",
  "i've changed", "i have changed", "i've updated the schedule",
  "i've added", "i have added", "i've assigned", "i have assigned",
  "done —", "consider it done", "it's done",
];

function parseJsonish(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON in: ${text.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── Mode: triage ────────────────────────────────────────────────────

async function runTriageMode() {
  if (!TOGETHER_API_KEY) {
    console.error("TOGETHER_API_KEY is required for triage mode.");
    process.exit(1);
  }

  const prompt = (sample) =>
    [
      `Classify the LATEST message in a parent carpool group's chat.`,
      `Latest message from Wei Chen: "${sample.body}"`,
      ``,
      `Recent earlier messages (for context, do not classify these):`,
      `[Maria Garcia] Anyone know if practice is still on?`,
      `[Crewmate AI] Wednesday morning is covered — Wei Chen is driving (Silver Honda) with Lily, Max, and Emma.`,
      ``,
      `Reply with JSON only: {"category": "question" | "action" | "consent" | "chatter", "confidence": number, "topic": string}.`,
      `question: asks about the schedule, rosters, coverage, times, who drives/rides, the weekly cycle.`,
      `action: requests a schedule change (cancel a ride, switch cars, volunteer, add a drive, change seat count).`,
      `consent: confirms or declines a pending proposal card.`,
      `chatter: social conversation or anything unrelated to the carpool schedule.`,
    ].join("\n");

  let correct = 0;
  const failures = [];
  // Together's 31B triage model can take ~20s per call; run with bounded
  // concurrency and a hard per-call timeout so one hang can't stall the gate.
  const CONCURRENCY = 5;
  const results = new Array(TRIAGE_SAMPLES.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= TRIAGE_SAMPLES.length) return;
      const sample = TRIAGE_SAMPLES[i];
      try {
        const res = await fetch("https://api.together.xyz/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${TOGETHER_API_KEY}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify({
            model: TRIAGE_MODEL,
            max_tokens: 1000, // reasoning models think before emitting JSON — 200 was consumed by thinking alone
            temperature: 0,
            messages: [{ role: "user", content: prompt(sample) }],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        results[i] = { got: parseJsonish(data.choices?.[0]?.message?.content ?? "").category ?? null, raw: "" };
      } catch (e) {
        results[i] = { got: `ERROR: ${e.message}`, raw: "" };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (let i = 0; i < TRIAGE_SAMPLES.length; i++) {
    const got = results[i].got;
    if (got === TRIAGE_SAMPLES[i].expected) correct++;
    else failures.push({ sample: TRIAGE_SAMPLES[i], got, raw: results[i].raw });
  }

  const accuracy = correct / TRIAGE_SAMPLES.length;
  console.log(`\nTriage eval: ${correct}/${TRIAGE_SAMPLES.length} correct (${(accuracy * 100).toFixed(1)}%) with ${TRIAGE_MODEL}`);
  console.log(`Threshold: ${THRESHOLD * 100}%`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  expected=${f.sample.expected} got=${f.got} body="${f.sample.body}"${f.raw ? `\n    raw: ${f.raw}` : ""}`);
    }
  }
  if (accuracy < THRESHOLD) {
    console.error(`\nFAIL: triage accuracy ${(accuracy * 100).toFixed(1)}% < ${(THRESHOLD * 100).toFixed(0)}%. Do not enable the group flag.`);
    process.exit(1);
  }
  console.log("\nPASS: triage eval gate.");
}

// ── Mode: e2e (staging pipeline) ────────────────────────────────────

function verifyLinkedProject() {
  try {
    const linkedRef = readFileSync(path.join(import.meta.dirname, "..", "supabase/.temp/project-ref"), "utf8").trim();
    if (linkedRef !== PROJECT_REF) {
      console.error(`CLI linked to ${linkedRef} but PROJECT_REF is ${PROJECT_REF}. Run "npm run link:test".`);
      process.exit(1);
    }
  } catch {
    console.error("Could not read linked project ref. Run 'npm run link:test'.");
    process.exit(1);
  }
}

function getServiceKey() {
  if (process.env.SUPABASE_TEST_SERVICE_KEY) return process.env.SUPABASE_TEST_SERVICE_KEY;
  try {
    const cliToken = execSync('security find-generic-password -s "Supabase CLI" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const result = execSync(`curl -s -H "Authorization: Bearer ${cliToken}" "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys"`, { encoding: "utf8" });
    const parsed = JSON.parse(result);
    const keyList = Array.isArray(parsed) ? parsed : (parsed.keys ?? []);
    for (const k of keyList) { if (k.id === "service_role") return k.api_key; }
  } catch {}
  return null;
}

async function runE2eMode() {
  verifyLinkedProject();
  const SERVICE_KEY = getServiceKey();
  if (!SERVICE_KEY) {
    console.error("Could not resolve Supabase service key.");
    process.exit(1);
  }

  // Sign in as a demo parent.
  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!tokenRes.ok) {
    console.error(`Sign-in failed for ${DEMO_EMAIL}: ${await tokenRes.text()}`);
    console.error("Run `npm run seed-demo` first.");
    process.exit(1);
  }
  const { access_token: jwt } = await tokenRes.json();

  const authHeaders = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" };
  const serviceHeaders = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  const rpc = async (name, args) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(args ?? {}),
    });
    if (!res.ok) throw new Error(`${name} failed: ${await res.text()}`);
    return res.json();
  };

  const agentThreadId = await rpc("ensure_agent_thread", { target_group_id: GROUP_ID });
  const everyoneThreadId = await rpc("ensure_everyone_thread", { target_group_id: GROUP_ID });

  // Check the group flag + run a sanity read on the ledger.
  const groupRes = await fetch(`${SUPABASE_URL}/rest/v1/groups?select=crewmate_enabled&id=eq.${GROUP_ID}`, { headers: serviceHeaders });
  const group = (await groupRes.json())[0];
  if (!group?.crewmate_enabled) {
    console.error("crewmate_enabled is false on the pilot group. Flip it on first (see docs/crewmate-runbook.md):");
    console.error(`  update public.groups set crewmate_enabled = true where id = '${GROUP_ID}';`);
    process.exit(1);
  }

  const postedIds = [];
  let passed = 0;
  let failed = 0;

  const postMessage = async (threadId, body) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
      method: "POST",
      headers: { ...authHeaders, "Prefer": "return=representation" },
      body: JSON.stringify({ thread_id: threadId, sender_kind: "parent", body: `[eval] ${body}` }),
    });
    if (!res.ok) throw new Error(`post failed: ${await res.text()}`);
    const row = (await res.json())[0];
    postedIds.push(row.id);
    return row;
  };

  const waitForReply = async (threadId, afterCreatedAt, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/chat_messages?select=id,body,created_at,sender_kind&thread_id=eq.${threadId}&sender_kind=eq.agent&created_at=gt.${encodeURIComponent(afterCreatedAt)}&order=created_at.asc&limit=5`,
        { headers: serviceHeaders },
      );
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) return rows;
    }
    return [];
  };

  console.log(`\nE2E eval against ${SUPABASE_URL} as ${DEMO_EMAIL} (${TRIAGE_MODEL} → planner)\n`);
  for (const sample of E2E_SAMPLES) {
    const threadId = sample.thread === "agent" ? agentThreadId : everyoneThreadId;
    try {
      const msg = await postMessage(threadId, sample.body);
      const replies = await waitForReply(threadId, msg.created_at, sample.expectReply ? 60_000 : 45_000);
      const gotReply = replies.length > 0;
      let ok = gotReply === sample.expectReply;
      let note = gotReply ? replies[0].body.slice(0, 140) : "(no reply)";
      if (ok && gotReply) {
        const lower = replies[0].body.toLowerCase();
        const forbidden = FORBIDDEN_IN_REPLY.find((f) => lower.includes(f));
        if (forbidden) {
          ok = false;
          note = `REPLY CLAIMS A CHANGE ("${forbidden}"): ${note}`;
        }
      }
      if (ok) passed++; else { failed++; }
      console.log(`${ok ? "PASS" : "FAIL"} [${sample.thread}] "${sample.body}" → ${note}`);
    } catch (e) {
      failed++;
      console.log(`FAIL [${sample.thread}] "${sample.body}" → ${e.message}`);
    }
  }

  // Clean up eval messages so staging threads stay reviewable.
  const idList = postedIds.join(",");
  if (idList) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/chat_messages?id=in.(${idList})`, { method: "DELETE", headers: serviceHeaders });
      // Also remove any agent replies the eval triggered.
      await fetch(`${SUPABASE_URL}/rest/v1/chat_messages?thread_id=eq.${agentThreadId}&body=like.[eval]*`, { method: "DELETE", headers: serviceHeaders });
    } catch {}
  }

  const total = passed + failed;
  const accuracy = total > 0 ? passed / total : 0;
  console.log(`\nE2E eval: ${passed}/${total} passed (${(accuracy * 100).toFixed(1)}%)`);
  if (failed > 0) {
    console.error("\nFAIL: e2e eval. Inspect crewmate_runs (status, outcome_detail) on staging.");
    process.exit(1);
  }
  console.log("\nPASS: e2e eval gate.");
}

if (MODE === "e2e") {
  await runE2eMode();
} else if (MODE === "triage") {
  await runTriageMode();
} else {
  console.error(`Unknown mode "${MODE}". Use --mode triage|e2e.`);
  process.exit(1);
}