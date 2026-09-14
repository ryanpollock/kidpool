// Crewmate AI — Phase 1 (Q&A-only). Spec: CREWMATE_REQUIREMENTS.md §5.
//
// Invoked by the chat_messages_notify_agent DB trigger (pg_net) with
// { thread_id, message_id }. Auth: Bearer CRON_SECRET or SERVICE_ROLE_KEY
// (trigger-only, like send-push's chat_message branch).
//
// Flow: claim run (per-thread coalescing) → budget check → triage (fast
// model; skipped in private 'agent' threads) → planner (tool-calling model
// with read-only schedule tools) → post ONE agent message → ledger.
//
// Phase 1 hard boundary: this function's ONLY writes are
//   - chat_messages rows with sender_kind='agent'
//   - its own crewmate_runs ledger row
// It never writes chat_proposals and never writes any schedule table.
// That boundary is contract-tested (tests/crewmate.test.mjs) — do not
// weaken it without updating the requirements doc.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.111.0";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@3.0.48";
import { generateText, generateObject, tool, Output, isStepCount } from "npm:ai@7.0.99";
import { z } from "npm:zod@4.6.5";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const TOGETHER_API_KEY = Deno.env.get("TOGETHER_API_KEY");
// Model IDs are config values (CREWMATE_REQUIREMENTS.md §10): swap freely,
// qualified by the Phase 1 eval gate (scripts/crewmate-eval.mjs).
const TRIAGE_MODEL = Deno.env.get("CREWMATE_TRIAGE_MODEL") ?? "google/gemma-4-31b-it";
const PLANNER_MODEL = Deno.env.get("CREWMATE_PLANNER_MODEL") ?? "deepseek-ai/DeepSeek-V4-Flash";

const MAX_AGENT_BODY = 3900; // chat_messages caps body at 4000
const COALESCE_WINDOW_MS = 90_000;
const MAX_REPLAN_PASSES = 3;
const MESSAGE_WINDOW = 24; // transcript length for the planner

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function verifyAuth(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  if (CRON_SECRET && token === CRON_SECRET) return true;
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return true;
  return false;
}

// ── Timezone helpers (the group's timezone, not the server's) ────────

function dateInTz(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function mondayOf(dateIso: string): string {
  const d = new Date(dateIso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  const back = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function humanNow(tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date());
}

// ── Data types (tool results) ─────────────────────────────────────────

type CarSummary = {
  driver: string;
  vehicle: string;
  capacity: number;
  status: string;
  children: string[];
};

type TripSummary = {
  service_date: string;
  slot: string;
  direction: string;
  meeting_time: string;
  departure_time: string;
  origin: string;
  destination: string;
  cars: CarSummary[];
  children_needing_rides: string[];
  unassigned_children: string[];
};

const SLOT_LABELS: Record<string, string> = {
  am: "morning",
  pm_early: "afternoon early",
  pm_late: "afternoon late",
  custom: "custom (extra drive)",
};

// ── Read tools (service client; explicit columns; no contact data) ───

type ToolCtx = { groupId: string; senderProfileId: string; calls: { name: string; args: unknown }[] };

function childName(c: { first_name: string; last_name: string }): string {
  return `${c.first_name} ${c.last_name}`.trim();
}

async function buildRosters(
  admin: SupabaseClient,
  groupIds: { groupId: string; tripIds: string[] },
): Promise<{ trips: TripSummary[]; byTripId: Map<string, TripSummary> }> {
  const { data: trips } = await admin.from("trips")
    .select("id,week_id,service_date,slot,direction,meeting_time,departure_time,origin,destination")
    .eq("group_id", groupIds.groupId)
    .in("id", groupIds.tripIds)
    .order("service_date")
    .order("meeting_time");

  const summaries: TripSummary[] = [];
  const byTripId = new Map<string, TripSummary>();

  if (trips && trips.length > 0) {
    // Latest schedule version per trip week: published wins, else highest draft.
    const weekIds = [...new Set((trips as any[]).map((t) => t.week_id))];
    const { data: versions } = await admin.from("schedule_versions")
      .select("id,week_id,version_number,status")
      .eq("group_id", groupIds.groupId)
      .in("week_id", weekIds)
      .in("status", ["published", "draft"])
      .order("version_number", { ascending: false });
    const versionByWeek = new Map<string, string>();
    for (const v of versions ?? []) {
      if (v.status === "published" || !versionByWeek.has(v.week_id)) {
        versionByWeek.set(v.week_id, v.id);
      }
    }
    const versionIds = [...new Set([...versionByWeek.values()])];

    let driverAssignments: any[] = [];
    if (versionIds.length > 0) {
      const { data: das } = await admin.from("driver_assignments")
        .select("id,trip_id,driver_profile_id,vehicle_id,status,child_passenger_capacity")
        .eq("group_id", groupIds.groupId)
        .in("schedule_version_id", versionIds)
        .in("trip_id", groupIds.tripIds)
        .in("status", ["tentative", "confirmed"]);
      driverAssignments = das ?? [];
    }

    // Ride demand from check-ins.
    const { data: rideRequests } = await admin.from("ride_requests")
      .select("trip_id,child_id")
      .eq("group_id", groupIds.groupId)
      .in("trip_id", groupIds.tripIds)
      .eq("needs_ride", true);

    const daIds = driverAssignments.map((da) => da.id);
    let riderAssignments: any[] = [];
    if (daIds.length > 0) {
      const { data: ras } = await admin.from("rider_assignments")
        .select("driver_assignment_id,child_id,trip_id")
        .in("driver_assignment_id", daIds);
      riderAssignments = ras ?? [];
    }

    const childIds = [
      ...new Set([...(rideRequests ?? []).map((r: any) => r.child_id), ...riderAssignments.map((ra: any) => ra.child_id)]),
    ];
    let childrenById = new Map<string, { first_name: string; last_name: string }>();
    if (childIds.length > 0) {
      const { data: kids } = await admin.from("children")
        .select("id,first_name,last_name")
        .eq("group_id", groupIds.groupId)
        .in("id", childIds);
      childrenById = new Map((kids ?? []).map((k: any) => [k.id, k]));
    }

    const driverIds = [...new Set(driverAssignments.map((da) => da.driver_profile_id))];
    let driversById = new Map<string, string>();
    if (driverIds.length > 0) {
      const { data: drivers } = await admin.from("profiles")
        .select("id,full_name")
        .in("id", driverIds);
      driversById = new Map((drivers ?? []).map((p: any) => [p.id, p.full_name]));
    }

    const vehicleIds = [...new Set(driverAssignments.map((da) => da.vehicle_id).filter(Boolean))];
    let vehiclesById = new Map<string, string>();
    if (vehicleIds.length > 0) {
      const { data: vehicles } = await admin.from("vehicles")
        .select("id,label")
        .eq("group_id", groupIds.groupId)
        .in("id", vehicleIds);
      vehiclesById = new Map((vehicles ?? []).map((v: any) => [v.id, v.label]));
    }

    const ridersByDa = new Map<string, string[]>();
    for (const ra of riderAssignments) {
      const kid = childrenById.get(ra.child_id);
      if (!kid) continue;
      const arr = ridersByDa.get(ra.driver_assignment_id) ?? [];
      arr.push(childName(kid));
      ridersByDa.set(ra.driver_assignment_id, arr);
    }
    const seatedChildIds = new Set(riderAssignments.map((ra: any) => ra.child_id));

    const demandByTrip = new Map<string, string[]>();
    for (const rr of rideRequests ?? []) {
      const kid = childrenById.get(rr.child_id);
      if (!kid) continue;
      const arr = demandByTrip.get(rr.trip_id) ?? [];
      arr.push(childName(kid));
      demandByTrip.set(rr.trip_id, arr);
    }

    for (const t of trips as any[]) {
      const cars: CarSummary[] = driverAssignments
        .filter((da) => da.trip_id === t.id)
        .map((da) => ({
          driver: driversById.get(da.driver_profile_id) ?? "a driver",
          vehicle: vehiclesById.get(da.vehicle_id) ?? "",
          capacity: da.child_passenger_capacity,
          status: da.status,
          children: ridersByDa.get(da.id) ?? [],
        }));

      const demand = demandByTrip.get(t.id) ?? [];
      const demandChildIds = (rideRequests ?? []).filter((r: any) => r.trip_id === t.id).map((r: any) => r.child_id);
      const unassigned = demandChildIds
        .filter((cid) => !seatedChildIds.has(cid))
        .map((cid) => childName(childrenById.get(cid)!))
        .filter(Boolean);

      const summary: TripSummary = {
        service_date: t.service_date,
        slot: SLOT_LABELS[t.slot] ?? t.slot,
        direction: t.direction,
        meeting_time: String(t.meeting_time).slice(0, 5),
        departure_time: String(t.departure_time).slice(0, 5),
        origin: t.origin,
        destination: t.destination,
        cars,
        children_needing_rides: demand,
        unassigned_children: unassigned,
      };
      summaries.push(summary);
      byTripId.set(t.id, summary);
    }
  }

  return { trips: summaries, byTripId };
}

async function weekOverview(ctx: ToolCtx, admin: SupabaseClient, weekStart?: string) {
  const { data: group } = await admin.from("groups")
    .select("timezone")
    .eq("id", ctx.groupId)
    .single();
  const tz = group?.timezone ?? "America/Los_Angeles";
  const todayIso = dateInTz(tz);
  const target = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? weekStart : mondayOf(todayIso);

  const { data: week } = await admin.from("weeks")
    .select("id,starts_on,status,checkin_deadline,confirmation_deadline,published_at")
    .eq("group_id", ctx.groupId)
    .eq("starts_on", target)
    .maybeSingle();

  if (!week) {
    return { error: `No week record starts ${target}. The schedule may not cover those dates yet.` };
  }

  const { data: tripRows } = await admin.from("trips")
    .select("id")
    .eq("group_id", ctx.groupId)
    .eq("week_id", week.id);
  const tripIds = (tripRows ?? []).map((t: any) => t.id);

  const { trips } = await buildRosters(admin, { groupId: ctx.groupId, tripIds });

  return {
    today: todayIso,
    week: {
      starts_on: week.starts_on,
      status: week.status,
      checkin_deadline: week.checkin_deadline,
      confirmation_deadline: week.confirmation_deadline,
      published_at: week.published_at,
    },
    trips,
  };
}

async function tripDetail(ctx: ToolCtx, admin: SupabaseClient, serviceDate: string, slot?: string) {
  let query = admin.from("trips")
    .select("id")
    .eq("group_id", ctx.groupId)
    .eq("service_date", serviceDate);
  if (slot) query = query.eq("slot", slot);
  const { data: tripRows } = await query;
  const tripIds = (tripRows ?? []).map((t: any) => t.id);
  if (tripIds.length === 0) {
    return { error: `No trip found for ${serviceDate}${slot ? ` (${SLOT_LABELS[slot] ?? slot})` : ""}.` };
  }
  const { byTripId } = await buildRosters(admin, { groupId: ctx.groupId, tripIds });
  return { trips: [...byTripId.values()] };
}

async function customDrives(ctx: ToolCtx, admin: SupabaseClient, serviceDate: string) {
  const { data: tripRows } = await admin.from("trips")
    .select("id")
    .eq("group_id", ctx.groupId)
    .eq("service_date", serviceDate)
    .eq("slot", "custom");
  const tripIds = (tripRows ?? []).map((t: any) => t.id);
  if (tripIds.length === 0) return { drives: [] as unknown[] };

  const { byTripId } = await buildRosters(admin, { groupId: ctx.groupId, tripIds });
  const drives = [...byTripId.values()].map((t) => ({
    ...t,
    seats_remaining: t.cars.reduce((sum, c) => sum + Math.max(0, c.capacity - c.children.length), 0),
  }));
  return { drives };
}

async function householdSnapshot(ctx: ToolCtx, admin: SupabaseClient) {
  const { data: profile } = await admin.from("profiles")
    .select("id,full_name")
    .eq("id", ctx.senderProfileId)
    .maybeSingle();
  if (!profile) return { error: "Sender profile not found." };

  const { data: membership } = await admin.from("memberships")
    .select("household_id")
    .eq("profile_id", ctx.senderProfileId)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return { error: "No active membership." };
  const householdId = membership.household_id;

  const { data: household } = await admin.from("households")
    .select("name")
    .eq("id", householdId)
    .maybeSingle();

  const { data: adultsRows } = await admin.from("memberships")
    .select("profile_id")
    .eq("household_id", householdId)
    .eq("status", "active");
  const adultIds = (adultsRows ?? []).map((m: any) => m.profile_id);
  const { data: adults } = adultIds.length > 0
    ? await admin.from("profiles").select("full_name").in("id", adultIds)
    : { data: [] };

  const { data: children } = await admin.from("children")
    .select("id,first_name,last_name,is_priority,active")
    .eq("household_id", householdId);

  const { data: vehicles } = await admin.from("vehicles")
    .select("label,child_passenger_capacity,active")
    .eq("household_id", householdId);

  // This week's drives + rides for the household.
  const { data: group } = await admin.from("groups").select("timezone").eq("id", ctx.groupId).single();
  const todayIso = dateInTz(group?.timezone ?? "America/Los_Angeles");
  const { data: week } = await admin.from("weeks")
    .select("id,starts_on")
    .eq("group_id", ctx.groupId)
    .eq("starts_on", mondayOf(todayIso))
    .maybeSingle();

  const myDrives: unknown[] = [];
  const ourRides: unknown[] = [];
  if (week) {
    const { data: tripRows } = await admin.from("trips").select("id").eq("week_id", week.id);
    const tripIds = (tripRows ?? []).map((t: any) => t.id);
    if (tripIds.length > 0) {
      const { data: versions } = await admin.from("schedule_versions")
        .select("id,status,version_number")
        .eq("week_id", week.id)
        .in("status", ["published", "draft"])
        .order("version_number", { ascending: false });
      const version = versions?.find((v: any) => v.status === "published") ?? versions?.[0];
      if (version) {
        const { data: myAssignments } = await admin.from("driver_assignments")
          .select("id,status,trip_id,vehicle_id")
          .eq("driver_profile_id", ctx.senderProfileId)
          .eq("schedule_version_id", version.id)
          .in("status", ["tentative", "confirmed"]);
        if (myAssignments && myAssignments.length > 0) {
          const { byTripId } = await buildRosters(admin, {
            groupId: ctx.groupId,
            tripIds: myAssignments.map((a: any) => a.trip_id),
          });
          for (const a of myAssignments) {
            const t = byTripId.get(a.trip_id);
            myDrives.push({
              date: t?.service_date,
              slot: t?.slot,
              meeting_time: t?.meeting_time,
              status: a.status,
              children: t?.cars.find((c) => c.driver === profile.full_name)?.children ?? [],
            });
          }
        }

        const kidIds = (children ?? []).map((c: any) => c.id);
        if (kidIds.length > 0) {
          const { data: rides } = await admin.from("rider_assignments")
            .select("child_id,driver_assignment_id,trip_id")
            .eq("schedule_version_id", version.id)
            .in("child_id", kidIds);
          if (rides && rides.length > 0) {
            const { byTripId } = await buildRosters(admin, {
              groupId: ctx.groupId,
              tripIds: [...new Set(rides.map((r: any) => r.trip_id))],
            });
            const kidNames = new Map((children ?? []).map((c: any) => [c.id, c.first_name]));
            for (const r of rides) {
              const t = byTripId.get(r.trip_id);
              ourRides.push({
                child: kidNames.get(r.child_id),
                date: t?.service_date,
                slot: t?.slot,
                meeting_time: t?.meeting_time,
              });
            }
          }
        }
      }
    }
  }

  return {
    profile: { full_name: profile.full_name, household: household?.name },
    adults: (adults ?? []).map((a: any) => a.full_name),
    children: (children ?? []).map((c: any) => ({
      name: childName(c), is_priority: c.is_priority, active: c.active,
    })),
    vehicles: (vehicles ?? []).map((v: any) => ({ label: v.label, seats: v.child_passenger_capacity, active: v.active })),
    my_drives_this_week: myDrives,
    our_rides_this_week: ourRides,
  };
}

// ── Triage (fast model; structured output) ────────────────────────────

const TriageSchema = z.object({
  category: z.enum(["question", "action", "consent", "chatter"]).describe(
    "question: asks about the schedule/rosters/coverage/times. action: requests a schedule change. consent: confirms or declines a pending proposal. chatter: social or unrelated.",
  ),
  confidence: z.number().min(0).max(1),
  topic: z.string().describe("A few words on what the message is about."),
});

function recentTranscript(messages: any[]): string {
  return messages
    .map((m) => {
      if (m.sender_kind === "system") return `[system note] ${m.body}`;
      if (m.sender_kind === "agent") return `[Crewmate AI] ${m.body}`;
      return `[${m.sender_name}] ${m.body}`;
    })
    .join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

  if (!verifyAuth(req.headers.get("Authorization"))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!SERVICE_ROLE_KEY) return jsonResponse({ error: "Service role key not configured" }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { apikey: SERVICE_ROLE_KEY } },
  });

  let body: { thread_id?: string; message_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { thread_id: threadId, message_id: messageId } = body ?? {};
  if (!threadId || !messageId) return jsonResponse({ error: "thread_id and message_id required" }, 400);

  try {
    // Defense in depth beyond the trigger's flag gate.
    const { data: thread } = await admin.from("chat_threads")
      .select("id,group_id,kind,title")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread) return jsonResponse({ skipped: "thread_not_found" });

    const { data: group } = await admin.from("groups")
      .select("id,name,timezone,meeting_point,school_name,crewmate_enabled,crewmate_monthly_token_budget")
      .eq("id", thread.group_id)
      .single();
    if (!group?.crewmate_enabled) return jsonResponse({ skipped: "disabled" });

    const { data: message } = await admin.from("chat_messages")
      .select("id,thread_id,sender_profile_id,sender_kind,sender_name,body,created_at")
      .eq("id", messageId)
      .maybeSingle();
    if (!message || message.thread_id !== threadId || message.sender_kind !== "parent" || !message.sender_profile_id) {
      return jsonResponse({ skipped: "message_not_applicable" });
    }

    // Per-thread coalescing.
    const { data: runId } = await admin.rpc("claim_crewmate_run", {
      p_group_id: thread.group_id,
      p_thread_id: threadId,
      p_trigger_message_id: messageId,
    });
    if (!runId) return jsonResponse({ coalesced: true });

    const finishRun = async (status: string, detail: Record<string, unknown>, usage?: {
      triage?: { in: number; out: number };
      planner?: { in: number; out: number };
    }) => {
      await admin.from("crewmate_runs").update({
        status,
        triage_model: usage?.triage ? TRIAGE_MODEL : null,
        planner_model: usage?.planner ? PLANNER_MODEL : null,
        triage_tokens_in: usage?.triage?.in ?? 0,
        triage_tokens_out: usage?.triage?.out ?? 0,
        planner_tokens_in: usage?.planner?.in ?? 0,
        planner_tokens_out: usage?.planner?.out ?? 0,
        outcome_detail: detail,
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    };

    // Monthly budget guard (inline check; Phase 4 automates the cron + UI).
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: monthRuns } = await admin.from("crewmate_runs")
      .select("triage_tokens_in,triage_tokens_out,planner_tokens_in,planner_tokens_out")
      .eq("group_id", thread.group_id)
      .gte("started_at", monthStart.toISOString());
    const tokensUsed = (monthRuns ?? []).reduce(
      (sum, r) => sum + (r.triage_tokens_in ?? 0) + (r.triage_tokens_out ?? 0) + (r.planner_tokens_in ?? 0) + (r.planner_tokens_out ?? 0),
      0,
    );
    if (tokensUsed >= (group.crewmate_monthly_token_budget ?? 0)) {
      await finishRun("skipped_budget", { error: "monthly_token_budget_exhausted", tokens_used: tokensUsed });
      return jsonResponse({ skipped: "budget" });
    }

    // No API key → fail-soft with a legible ledger reason (also the
    // deterministic local-test path).
    if (!TOGETHER_API_KEY) {
      await finishRun("failed", { error: "missing_together_api_key" });
      return jsonResponse({ skipped: "missing_together_api_key" });
    }

    const together = createOpenAICompatible({
      name: "together",
      baseURL: "https://api.together.xyz/v1",
      apiKey: TOGETHER_API_KEY,
    });

    // Sender household context for the system prompt.
    const { data: sender } = await admin.from("profiles")
      .select("id,full_name")
      .eq("id", message.sender_profile_id)
      .single();
    const { data: membership } = await admin.from("memberships")
      .select("household_id")
      .eq("profile_id", message.sender_profile_id)
      .eq("status", "active")
      .maybeSingle();
    let householdContext = "";
    if (membership) {
      const { data: hh } = await admin.from("households").select("name").eq("id", membership.household_id).maybeSingle();
      const { data: kids } = await admin.from("children")
        .select("first_name,last_name")
        .eq("household_id", membership.household_id)
        .eq("active", true);
      const { data: cars } = await admin.from("vehicles")
        .select("label,child_passenger_capacity")
        .eq("household_id", membership.household_id)
        .eq("active", true);
      householdContext = [
        `Their household: ${hh?.name ?? "unknown"}.`,
        `Their children: ${ (kids ?? []).map(childName).join(", ") || "none recorded" }.`,
        `Their vehicles: ${ (cars ?? []).map((v: any) => `${v.label} (${v.child_passenger_capacity} seats)`).join("; ") || "none" }.`,
      ].join(" ");
    }

    const threadKindLabel =
      thread.kind === "everyone" ? "the all-parents Everyone thread"
      : thread.kind === "group" ? `a group chat titled "${thread.title ?? "Group"}"`
      : thread.kind === "agent" ? "a private conversation between the parent and Crewmate AI"
      : "a direct message between two parents";

    // ── Triage (skipped in private Crewmate threads: every message there
    // is addressed to the agent by definition). ──
    let triageUsage: { in: number; out: number } | undefined;
    let category: "question" | "action" | "consent" = "question";
    let triageTopic = "";

    const { data: priorMessages } = await admin.from("chat_messages")
      .select("id,sender_kind,sender_name,body,created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(MESSAGE_WINDOW);
    const transcript = [...(priorMessages ?? [])].reverse();

    if (thread.kind !== "agent") {
      const triageResult = await generateObject({
        model: together(TRIAGE_MODEL),
        schema: TriageSchema,
        maxOutputTokens: 200,
        prompt: [
          `Classify the LATEST message in a parent carpool group's chat.`,
          `Latest message from ${message.sender_name}: "${message.body}"`,
          ``,
          `Recent earlier messages (for context, do not classify these):`,
          recentTranscript(transcript.slice(0, -1)),
        ].join("\n"),
      });
      triageUsage = {
        in: triageResult.usage.promptTokens ?? 0,
        out: triageResult.usage.completionTokens ?? 0,
      };
      category = triageResult.object.category;
      triageTopic = triageResult.object.topic;

      if (category === "chatter") {
        await finishRun("chatter", { category, topic: triageTopic }, { triage: triageUsage });
        return jsonResponse({ skipped: "chatter" });
      }
    }

    // ── Planner with read-only tools ──
    const ctx: ToolCtx = { groupId: thread.group_id, senderProfileId: message.sender_profile_id, calls: [] };

    const tools = {
      get_week_overview: tool({
        description: "The carpool week at a glance: every trip with its named drivers, vehicles, assigned children, and coverage. Pass week_start as a Monday in YYYY-MM-DD; omit for the current week.",
        inputSchema: z.object({ week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
        execute: async ({ week_start }) => {
          const result = await weekOverview(ctx, admin, week_start);
          ctx.calls.push({ name: "get_week_overview", args: { week_start } });
          return result;
        },
      }),
      get_trip_detail: tool({
        description: "Full named roster for one trip: drivers, vehicles, which child is in which car, times, and any uncovered children. service_date is YYYY-MM-DD; slot is one of am, pm_early, pm_late, custom.",
        inputSchema: z.object({
          service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          slot: z.enum(["am", "pm_early", "pm_late", "custom"]).optional(),
        }),
        execute: async ({ service_date, slot }) => {
          const result = await tripDetail(ctx, admin, service_date, slot);
          ctx.calls.push({ name: "get_trip_detail", args: { service_date, slot } });
          return result;
        },
      }),
      get_custom_drives: tool({
        description: "Ad hoc extra drives (like a late pickup) offered by parents on one date, with remaining seats.",
        inputSchema: z.object({ service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
        execute: async ({ service_date }) => {
          const result = await customDrives(ctx, admin, service_date);
          ctx.calls.push({ name: "get_custom_drives", args: { service_date } });
          return result;
        },
      }),
      get_household_snapshot: tool({
        description: "The asking parent's own household: adults, children, vehicles, their drives and their children's rides this week.",
        inputSchema: z.object({}),
        execute: async () => {
          const result = await householdSnapshot(ctx, admin);
          ctx.calls.push({ name: "get_household_snapshot", args: {} });
          return result;
        },
      }),
      run_sql_query: tool({
        description: "Last resort for questions the other tools can't answer (e.g. counts across weeks). ONE read-only SELECT against the group's schedule tables (groups, households, children, vehicles, weeks, trips, weekly_checkins, ride_requests, driver_availability, driver_assignments, rider_assignments, schedule_versions, driver_confirmations, audit_events). No semicolons, no comments, no phone/email columns. Never call more than twice.",
        inputSchema: z.object({ sql: z.string().min(1).max(4000) }),
        execute: async ({ sql }) => {
          const result = await admin.rpc("crewmate_readonly_query", { p_group_id: thread.group_id, p_sql: sql });
          ctx.calls.push({ name: "run_sql_query", args: { sql } });
          if (result.error) return { error: result.error.message };
          return result.data;
        },
      }),
    };

    const systemPrompt = [
      `You are Crewmate AI, the carpool assistant for "${group.name}" (meeting point: ${group.meeting_point}; school: ${group.school_name}).`,
      `Right now it is ${humanNow(group.timezone)} (${group.timezone}).`,
      `You are replying in ${threadKindLabel}, helping ${message.sender_name}. ${householdContext}`,
      ``,
      `Rules:`,
      `- Answer schedule questions from tool results. Never invent names, times, or assignments; if the tools don't answer it, say what you don't know.`,
      `- You CANNOT change the schedule. If the parent asks for a change (cancel a ride, switch a car, volunteer to drive, add a child, change a time), briefly state the current state and point them to where it's done in the app: the Next Week tab for check-in and ride-need changes, Home to confirm/decline a drive or volunteer for an open one, the Account screen for vehicles and children — or offer to flag the coordinator. Never say a change has been made. Never promise to make it.`,
      `- If a parent seems to be confirming or declining a pending proposal card, ask them to use the Confirm / Decline buttons on the card itself.`,
      `- Do not share phone numbers, emails, or addresses — you don't have them, and they stay private.`,
      `- Keep it short and warm: two to six sentences in plain language. Use children's first names and drivers' full names. A roster may be a short list, nothing longer.`,
      `- If the message is completely unrelated to the carpool, say in one sentence that you're here for carpool questions.`,
    ].join("\n");

    // Reload the transcript fresh on every planning pass so coalesced
    // messages (and the agent's own earlier replies) are always in context.
    const planOnce = async () => {
      const { data: fresh } = await admin.from("chat_messages")
        .select("id,sender_kind,sender_name,body,created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: false })
        .limit(MESSAGE_WINDOW);
      const currentTranscript = [...(fresh ?? [])].reverse();

      const result = await generateText({
        model: together(PLANNER_MODEL),
        system: systemPrompt,
        prompt: [
          `Conversation so far (oldest first):`,
          recentTranscript(currentTranscript),
          ``,
          `Reply to ${message.sender_name}'s latest message.`,
        ].join("\n"),
        tools,
        stopWhen: isStepCount(6),
        maxOutputTokens: 1500,
        timeout: { stepMs: 25_000 },
        output: Output.object({
          schema: z.object({
            answer: z.string().min(1).describe("The reply posted into the chat."),
            requested_action: z.string().nullable().describe(
              "If the parent asked for a schedule CHANGE, a short label like 'cancel Ava ride Tuesday'; otherwise null.",
            ),
          }),
        }),
      });
      return {
        output: result.output,
        usage: {
          in: result.usage.promptTokens ?? 0,
          out: result.usage.completionTokens ?? 0,
        },
      };
    };

    // Plan, then re-check for newer parent messages (coalesced bursts);
    // re-plan with a fresh transcript up to MAX_REPLAN_PASSES.
    let planned = await planOnce();
    for (let pass = 1; pass < MAX_REPLAN_PASSES; pass++) {
      const { data: newer } = await admin.from("chat_messages")
        .select("id")
        .eq("thread_id", threadId)
        .eq("sender_kind", "parent")
        .gt("created_at", message.created_at);
      if (!newer || newer.length === 0) break;
      planned = await planOnce();
    }

    const answer = (planned.output?.answer ?? "").trim();
    if (!answer) {
      await finishRun("failed", { error: "empty_answer" }, { triage: triageUsage, planner: planned.usage });
      return jsonResponse({ skipped: "empty_answer" });
    }

    // ── Post the agent message (the function's only schedule-adjacent write) ──
    const { data: agentMessage, error: insertError } = await admin.from("chat_messages")
      .insert({
        thread_id: threadId,
        sender_kind: "agent",
        sender_name: "Crewmate AI",
        body: answer.slice(0, MAX_AGENT_BODY),
      })
      .select("id")
      .single();
    if (insertError || !agentMessage) {
      await finishRun("failed", { error: insertError?.message ?? "insert_failed" }, { triage: triageUsage, planner: planned.usage });
      return jsonResponse({ error: "message_insert_failed" }, 200);
    }

    // Push for private Crewmate threads (agent messages never trigger the
    // push trigger; everywhere else Crewmate replies stay silent).
    if (thread.kind === "agent") {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "chat_message",
            thread_id: threadId,
            message_id: agentMessage.id,
          }),
        });
      } catch (e) {
        console.error("[chat-agent] agent-reply push failed (non-fatal):", e);
      }
    }

    const requestedAction = planned.output?.requested_action ?? null;
    await finishRun(
      requestedAction ? "action_deferred" : "answered",
      {
        category,
        topic: triageTopic,
        requested_action: requestedAction,
        coalesced_window_ms: COALESCE_WINDOW_MS,
      },
      { triage: triageUsage, planner: planned.usage },
    );
    // Persist the tool-call log for the gap analysis (separate update so
    // the ledger survives even if this write races).
    await admin.from("crewmate_runs").update({ tool_calls: ctx.calls }).eq("id", runId);

    return jsonResponse({ ok: true, message_id: agentMessage.id });
  } catch (e) {
    console.error("[chat-agent] run failed:", e);
    return jsonResponse({ error: "agent_failed" }, 200); // never error to pg_net
  }
});