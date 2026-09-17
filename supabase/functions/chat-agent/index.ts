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
import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@3.0.48";
import { generateText, tool, isStepCount } from "npm:ai@7.0.99";
import { z } from "npm:zod@4.6.5";
import { corsHeaders } from "../_shared/cors.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const TOGETHER_API_KEY = Deno.env.get("TOGETHER_API_KEY");
// Model IDs are config values (CREWMATE_REQUIREMENTS.md §10): swap freely,
// qualified by the Phase 1 eval gate (scripts/crewmate-eval.mjs).
const TRIAGE_MODEL = Deno.env.get("CREWMATE_TRIAGE_MODEL") ?? "zai-org/GLM-5.3-Flash";
const PLANNER_MODEL = Deno.env.get("CREWMATE_PLANNER_MODEL") ?? "zai-org/GLM-5.3-Flash";
const MAX_AGENT_BODY = 3900; // chat_messages caps body at 4000
const COALESCE_WINDOW_MS = 90_000;
const MAX_REPLAN_PASSES = 3;
const MESSAGE_WINDOW = 24; // transcript length for the planner
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
function verifyAuth(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  if (CRON_SECRET && token === CRON_SECRET) return true;
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return true;
  return false;
}
// ── Timezone helpers (the group's timezone, not the server's) ────────
function dateInTz(tz, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}
function mondayOf(dateIso) {
  const d = new Date(dateIso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  const back = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
function humanNow(tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date());
}
const SLOT_LABELS = {
  am: "morning",
  pm_early: "afternoon early",
  pm_late: "afternoon late",
  custom: "custom (extra drive)"
};
function childName(c) {
  return `${c.first_name} ${c.last_name}`.trim();
}
async function buildRosters(admin, groupIds) {
  const { data: trips } = await admin.from("trips").select("id,week_id,service_date,slot,direction,meeting_time,departure_time,origin,destination").eq("group_id", groupIds.groupId).in("id", groupIds.tripIds).order("service_date").order("meeting_time");
  const summaries = [];
  const byTripId = new Map();
  if (trips && trips.length > 0) {
    // Latest schedule version per trip week: published wins, else highest draft.
    const weekIds = [
      ...new Set(trips.map((t)=>t.week_id))
    ];
    const { data: versions } = await admin.from("schedule_versions").select("id,week_id,version_number,status").eq("group_id", groupIds.groupId).in("week_id", weekIds).in("status", [
      "published",
      "draft"
    ]).order("version_number", {
      ascending: false
    });
    const versionByWeek = new Map();
    for (const v of versions ?? []){
      if (v.status === "published" || !versionByWeek.has(v.week_id)) {
        versionByWeek.set(v.week_id, v.id);
      }
    }
    const versionIds = [
      ...new Set([
        ...versionByWeek.values()
      ])
    ];
    let driverAssignments = [];
    if (versionIds.length > 0) {
      const { data: das } = await admin.from("driver_assignments").select("id,trip_id,driver_profile_id,vehicle_id,status,child_passenger_capacity").eq("group_id", groupIds.groupId).in("schedule_version_id", versionIds).in("trip_id", groupIds.tripIds).in("status", [
        "tentative",
        "confirmed"
      ]);
      driverAssignments = das ?? [];
    }
    // Ride demand from check-ins.
    const { data: rideRequests } = await admin.from("ride_requests").select("trip_id,child_id").eq("group_id", groupIds.groupId).in("trip_id", groupIds.tripIds).eq("needs_ride", true);
    const daIds = driverAssignments.map((da)=>da.id);
    let riderAssignments = [];
    if (daIds.length > 0) {
      const { data: ras } = await admin.from("rider_assignments").select("driver_assignment_id,child_id,trip_id").in("driver_assignment_id", daIds);
      riderAssignments = ras ?? [];
    }
    const childIds = [
      ...new Set([
        ...(rideRequests ?? []).map((r)=>r.child_id),
        ...riderAssignments.map((ra)=>ra.child_id)
      ])
    ];
    let childrenById = new Map();
    if (childIds.length > 0) {
      const { data: kids } = await admin.from("children").select("id,first_name,last_name").eq("group_id", groupIds.groupId).in("id", childIds);
      childrenById = new Map((kids ?? []).map((k)=>[
          k.id,
          k
        ]));
    }
    const driverIds = [
      ...new Set(driverAssignments.map((da)=>da.driver_profile_id))
    ];
    let driversById = new Map();
    if (driverIds.length > 0) {
      const { data: drivers } = await admin.from("profiles").select("id,full_name").in("id", driverIds);
      driversById = new Map((drivers ?? []).map((p)=>[
          p.id,
          p.full_name
        ]));
    }
    const vehicleIds = [
      ...new Set(driverAssignments.map((da)=>da.vehicle_id).filter(Boolean))
    ];
    let vehiclesById = new Map();
    if (vehicleIds.length > 0) {
      const { data: vehicles } = await admin.from("vehicles").select("id,label").eq("group_id", groupIds.groupId).in("id", vehicleIds);
      vehiclesById = new Map((vehicles ?? []).map((v)=>[
          v.id,
          v.label
        ]));
    }
    const ridersByDa = new Map();
    for (const ra of riderAssignments){
      const kid = childrenById.get(ra.child_id);
      if (!kid) continue;
      const arr = ridersByDa.get(ra.driver_assignment_id) ?? [];
      arr.push(childName(kid));
      ridersByDa.set(ra.driver_assignment_id, arr);
    }
    const seatedChildIds = new Set(riderAssignments.map((ra)=>ra.child_id));
    const demandByTrip = new Map();
    for (const rr of rideRequests ?? []){
      const kid = childrenById.get(rr.child_id);
      if (!kid) continue;
      const arr = demandByTrip.get(rr.trip_id) ?? [];
      arr.push(childName(kid));
      demandByTrip.set(rr.trip_id, arr);
    }
    for (const t of trips){
      const cars = driverAssignments.filter((da)=>da.trip_id === t.id).map((da)=>({
          driver: driversById.get(da.driver_profile_id) ?? "a driver",
          driver_profile_id: da.driver_profile_id,
          vehicle: vehiclesById.get(da.vehicle_id) ?? "",
          vehicle_id: da.vehicle_id,
          driver_assignment_id: da.id,
          capacity: da.child_passenger_capacity,
          status: da.status,
          children: ridersByDa.get(da.id) ?? [],
          riders: riderAssignments.filter((ra)=>ra.driver_assignment_id === da.id).map((ra)=>({
              id: ra.child_id,
              name: childrenById.get(ra.child_id) ? childName(childrenById.get(ra.child_id)) : ""
            })).filter((r)=>r.name)
        }));
      const demand = demandByTrip.get(t.id) ?? [];
      const demandChildIds = (rideRequests ?? []).filter((r)=>r.trip_id === t.id).map((r)=>r.child_id);
      const unassigned = demandChildIds.filter((cid)=>!seatedChildIds.has(cid)).map((cid)=>childName(childrenById.get(cid))).filter(Boolean);
      const summary = {
        trip_id: t.id,
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
        unassigned_child_ids: demandChildIds.filter((cid)=>!seatedChildIds.has(cid))
      };
      summaries.push(summary);
      byTripId.set(t.id, summary);
    }
  }
  return {
    trips: summaries,
    byTripId
  };
}
async function weekOverview(ctx, admin, weekStart) {
  const { data: group } = await admin.from("groups").select("timezone").eq("id", ctx.groupId).single();
  const tz = group?.timezone ?? "America/Los_Angeles";
  const todayIso = dateInTz(tz);
  const target = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? weekStart : mondayOf(todayIso);
  const { data: week } = await admin.from("weeks").select("id,starts_on,status,checkin_deadline,confirmation_deadline,published_at").eq("group_id", ctx.groupId).eq("starts_on", target).maybeSingle();
  if (!week) {
    return {
      error: `No week record starts ${target}. The schedule may not cover those dates yet.`
    };
  }
  const { data: tripRows } = await admin.from("trips").select("id").eq("group_id", ctx.groupId).eq("week_id", week.id);
  const tripIds = (tripRows ?? []).map((t)=>t.id);
  const { trips } = await buildRosters(admin, {
    groupId: ctx.groupId,
    tripIds
  });
  return {
    today: todayIso,
    week: {
      starts_on: week.starts_on,
      status: week.status,
      checkin_deadline: week.checkin_deadline,
      confirmation_deadline: week.confirmation_deadline,
      published_at: week.published_at
    },
    trips
  };
}
async function tripDetail(ctx, admin, serviceDate, slot) {
  let query = admin.from("trips").select("id").eq("group_id", ctx.groupId).eq("service_date", serviceDate);
  if (slot) query = query.eq("slot", slot);
  const { data: tripRows } = await query;
  const tripIds = (tripRows ?? []).map((t)=>t.id);
  if (tripIds.length === 0) {
    return {
      error: `No trip found for ${serviceDate}${slot ? ` (${SLOT_LABELS[slot] ?? slot})` : ""}.`
    };
  }
  const { byTripId } = await buildRosters(admin, {
    groupId: ctx.groupId,
    tripIds
  });
  return {
    trips: [
      ...byTripId.values()
    ]
  };
}
async function customDrives(ctx, admin, serviceDate) {
  const { data: tripRows } = await admin.from("trips").select("id").eq("group_id", ctx.groupId).eq("service_date", serviceDate).eq("slot", "custom");
  const tripIds = (tripRows ?? []).map((t)=>t.id);
  if (tripIds.length === 0) return {
    drives: []
  };
  const { byTripId } = await buildRosters(admin, {
    groupId: ctx.groupId,
    tripIds
  });
  const drives = [
    ...byTripId.values()
  ].map((t)=>({
      ...t,
      seats_remaining: t.cars.reduce((sum, c)=>sum + Math.max(0, c.capacity - c.children.length), 0)
    }));
  return {
    drives
  };
}
async function householdSnapshot(ctx, admin) {
  const { data: profile } = await admin.from("profiles").select("id,full_name").eq("id", ctx.senderProfileId).maybeSingle();
  if (!profile) return {
    error: "Sender profile not found."
  };
  const { data: membership } = await admin.from("memberships").select("household_id").eq("profile_id", ctx.senderProfileId).eq("status", "active").maybeSingle();
  if (!membership) return {
    error: "No active membership."
  };
  const householdId = membership.household_id;
  const { data: household } = await admin.from("households").select("name").eq("id", householdId).maybeSingle();
  const { data: adultsRows } = await admin.from("memberships").select("profile_id").eq("household_id", householdId).eq("status", "active");
  const adultIds = (adultsRows ?? []).map((m)=>m.profile_id);
  const { data: adults } = adultIds.length > 0 ? await admin.from("profiles").select("full_name").in("id", adultIds) : {
    data: []
  };
  const { data: children } = await admin.from("children").select("id,first_name,last_name,is_priority,active").eq("household_id", householdId);
  const { data: vehicles } = await admin.from("vehicles").select("label,child_passenger_capacity,active").eq("household_id", householdId);
  // This week's drives + rides for the household.
  const { data: group } = await admin.from("groups").select("timezone").eq("id", ctx.groupId).single();
  const todayIso = dateInTz(group?.timezone ?? "America/Los_Angeles");
  const { data: week } = await admin.from("weeks").select("id,starts_on").eq("group_id", ctx.groupId).eq("starts_on", mondayOf(todayIso)).maybeSingle();
  const myDrives = [];
  const ourRides = [];
  if (week) {
    const { data: tripRows } = await admin.from("trips").select("id").eq("week_id", week.id);
    const tripIds = (tripRows ?? []).map((t)=>t.id);
    if (tripIds.length > 0) {
      const { data: versions } = await admin.from("schedule_versions").select("id,status,version_number").eq("week_id", week.id).in("status", [
        "published",
        "draft"
      ]).order("version_number", {
        ascending: false
      });
      const version = versions?.find((v)=>v.status === "published") ?? versions?.[0];
      if (version) {
        const { data: myAssignments } = await admin.from("driver_assignments").select("id,status,trip_id,vehicle_id").eq("driver_profile_id", ctx.senderProfileId).eq("schedule_version_id", version.id).in("status", [
          "tentative",
          "confirmed"
        ]);
        if (myAssignments && myAssignments.length > 0) {
          const { byTripId } = await buildRosters(admin, {
            groupId: ctx.groupId,
            tripIds: myAssignments.map((a)=>a.trip_id)
          });
          for (const a of myAssignments){
            const t = byTripId.get(a.trip_id);
            const myCar = t?.cars.find((c)=>c.driver_profile_id === ctx.senderProfileId);
            myDrives.push({
              date: t?.service_date,
              slot: t?.slot,
              meeting_time: t?.meeting_time,
              status: a.status,
              driver_assignment_id: a.id,
              trip_id: a.trip_id,
              vehicle: myCar?.vehicle ?? "",
              vehicle_id: myCar?.vehicle_id ?? null,
              children: myCar?.children ?? []
            });
          }
        }
        const kidIds = (children ?? []).map((c)=>c.id);
        if (kidIds.length > 0) {
          const { data: rides } = await admin.from("rider_assignments").select("child_id,driver_assignment_id,trip_id").eq("schedule_version_id", version.id).in("child_id", kidIds);
          if (rides && rides.length > 0) {
            const { byTripId } = await buildRosters(admin, {
              groupId: ctx.groupId,
              tripIds: [
                ...new Set(rides.map((r)=>r.trip_id))
              ]
            });
            const kidNames = new Map((children ?? []).map((c)=>[
                c.id,
                c.first_name
              ]));
            for (const r of rides){
              const t = byTripId.get(r.trip_id);
              ourRides.push({
                child: kidNames.get(r.child_id),
                date: t?.service_date,
                slot: t?.slot,
                meeting_time: t?.meeting_time
              });
            }
          }
        }
      }
    }
  }
  return {
    profile: {
      full_name: profile.full_name,
      household: household?.name
    },
    adults: (adults ?? []).map((a)=>a.full_name),
    children: (children ?? []).map((c)=>({
        id: c.id,
        name: childName(c),
        is_priority: c.is_priority,
        active: c.active
      })),
    vehicles: (vehicles ?? []).map((v)=>({
        id: v.id,
        label: v.label,
        seats: v.child_passenger_capacity,
        active: v.active
      })),
    my_drives_this_week: myDrives,
    our_rides_this_week: ourRides
  };
}
// ── Triage (fast model; structured output) ────────────────────────────
// Triage + consent-classifier output is prompted-for JSON and parsed
// leniently — the SDK's structured-output modes (response_format) are
// unreliable with Together's reasoning models, which emit hidden thinking
// before any content. The eval gates exercise this exact path.
function parseJsonish(text) {
  const cleaned = (text ?? "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch  {
    return null;
  }
}
const PROPOSAL_CATALOG = {
  cancel_ride: {
    confirmer: "child_parent",
    schema: z.object({
      child_id: z.string().uuid(),
      driver_assignment_id: z.string().uuid()
    })
  },
  cancel_ride_range: {
    confirmer: "child_parent",
    schema: z.object({
      child_id: z.string().uuid(),
      from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    })
  },
  switch_slot: {
    confirmer: "child_parent",
    schema: z.object({
      child_id: z.string().uuid(),
      driver_assignment_id: z.string().uuid()
    })
  },
  add_ride: {
    confirmer: "child_parent",
    schema: z.object({
      child_id: z.string().uuid(),
      trip_id: z.string().uuid()
    })
  },
  place_child: {
    confirmer: "child_parent",
    schema: z.object({
      child_id: z.string().uuid(),
      trip_id: z.string().uuid(),
      driver_assignment_id: z.string().uuid()
    })
  },
  decline_drive: {
    confirmer: "asker",
    schema: z.object({
      assignment_id: z.string().uuid(),
      decline_reason: z.string().max(500).optional()
    })
  },
  volunteer_drive: {
    confirmer: "asker",
    schema: z.object({
      trip_id: z.string().uuid(),
      schedule_version_id: z.string().uuid(),
      driver_assignment_id: z.string().uuid().optional()
    })
  },
  swap_drive: {
    confirmer: "swap_pair",
    schema: z.object({
      assignment_a: z.string().uuid(),
      assignment_b: z.string().uuid()
    })
  },
  change_vehicle: {
    confirmer: "asker",
    schema: z.object({
      driver_assignment_id: z.string().uuid(),
      vehicle_id: z.string().uuid()
    })
  },
  adjust_times: {
    confirmer: "coordinator_asker",
    schema: z.object({
      trip_id: z.string().uuid(),
      meeting_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
      departure_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/)
    })
  },
  cancel_trip: {
    confirmer: "coordinator_asker",
    schema: z.object({
      trip_id: z.string().uuid()
    })
  },
  admin_sql: {
    confirmer: "coordinator_asker",
    schema: z.object({
      sql: z.string().min(8).max(4000),
      preview_sql: z.string().max(4000).optional()
    })
  },
  offer_custom_drive: {
    confirmer: "asker",
    schema: z.object({
      service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      direction: z.enum([
        "morning",
        "afternoon"
      ]),
      meeting_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
      child_ids: z.array(z.string().uuid()).default([])
    })
  },
  join_custom_drive: {
    confirmer: "asker",
    schema: z.object({
      trip_id: z.string().uuid(),
      child_ids: z.array(z.string().uuid()).default([])
    })
  },
  leave_custom_drive: {
    confirmer: "child_parent",
    schema: z.object({
      trip_id: z.string().uuid(),
      child_id: z.string().uuid()
    })
  },
  cancel_custom_drive: {
    confirmer: "asker",
    schema: z.object({
      trip_id: z.string().uuid()
    })
  }
};
// Extract the last fenced \u0060\u0060\u0060crewmate block; returns {block, visible}.
function splitProposalBlock(answer) {
  // Tolerant fence parse: case-insensitive, flexible spacing after the
  // fence word. LLMs drift on exact fence formatting; the JSON inside is
  // the contract, not the whitespace.
  const re = /```[ \t]*crewmate[ \t]*\r?\n([\s\S]*?)```/gi;
  let last = null;
  let m;
  while((m = re.exec(answer)) !== null){
    try {
      last = JSON.parse(m[1]);
    } catch  {}
  }
  const visible = answer.replace(/```[ \t]*crewmate[ \t]*\r?\n[\s\S]*?```\n?/gi, "").trim();
  return {
    block: last,
    visible
  };
}
function recentTranscript(messages) {
  return messages.map((m)=>{
    if (m.sender_kind === "system") return `[system note] ${m.body}`;
    if (m.sender_kind === "agent") return `[Crewmate AI] ${m.body}`;
    return `[${m.sender_name}] ${m.body}`;
  }).join("\n");
}
// ── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return jsonResponse({
    error: "POST required"
  }, 405);
  if (!verifyAuth(req.headers.get("Authorization"))) {
    return jsonResponse({
      error: "Unauthorized"
    }, 401);
  }
  if (!SERVICE_ROLE_KEY) return jsonResponse({
    error: "Service role key not configured"
  }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: {
      headers: {
        apikey: SERVICE_ROLE_KEY
      }
    }
  });
  // Claimed run id, hoisted so the error path can always record the failure
  // in the ledger instead of leaving a 'running' row for the reaper.
  let claimedRunId = null;
  let body;
  try {
    body = await req.json();
  } catch  {
    return jsonResponse({
      error: "Invalid JSON body"
    }, 400);
  }
  const { thread_id: threadId, message_id: messageId } = body ?? {};
  if (!threadId || !messageId) return jsonResponse({
    error: "thread_id and message_id required"
  }, 400);
  try {
    // Defense in depth beyond the trigger's flag gate.
    const { data: thread } = await admin.from("chat_threads").select("id,group_id,kind,title").eq("id", threadId).maybeSingle();
    if (!thread) return jsonResponse({
      skipped: "thread_not_found"
    });
    const { data: group } = await admin.from("groups").select("id,name,timezone,meeting_point,school_name,crewmate_enabled,crewmate_monthly_token_budget").eq("id", thread.group_id).single();
    if (!group?.crewmate_enabled) return jsonResponse({
      skipped: "disabled"
    });
    const { data: message } = await admin.from("chat_messages").select("id,thread_id,sender_profile_id,sender_kind,sender_name,body,created_at,mentions").eq("id", messageId).maybeSingle();
    if (!message || message.thread_id !== threadId || message.sender_kind !== "parent" || !message.sender_profile_id) {
      return jsonResponse({
        skipped: "message_not_applicable"
      });
    }
    // @Crewmate is an explicit invocation: the validation trigger sanctions
  // exactly one null-profile mention form (label "@Crewmate"), so a null
  // profile_id here means the parent tagged the agent on purpose. Tagged
  // messages always run the planner — no triage silence, no NOREPLY gate —
  // exactly like the private Crewmate thread.
  const taggedCrewmate = ((message.mentions as any[] | null) ?? []).some((m) => m && !m.profile_id);

  // Per-thread coalescing.
    const { data: runId } = await admin.rpc("claim_crewmate_run", {
      p_group_id: thread.group_id,
      p_thread_id: threadId,
      p_trigger_message_id: messageId
    });
    if (!runId) return jsonResponse({
      coalesced: true
    });
    claimedRunId = runId;
    const finishRun = async (status, detail, usage)=>{
      await admin.from("crewmate_runs").update({
        status,
        triage_model: usage?.triage ? TRIAGE_MODEL : null,
        planner_model: usage?.planner ? PLANNER_MODEL : null,
        triage_tokens_in: usage?.triage?.in ?? 0,
        triage_tokens_out: usage?.triage?.out ?? 0,
        planner_tokens_in: usage?.planner?.in ?? 0,
        planner_tokens_out: usage?.planner?.out ?? 0,
        outcome_detail: detail,
        finished_at: new Date().toISOString()
      }).eq("id", runId);
    };
    // Monthly budget guard (inline check; Phase 4 automates the cron + UI).
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: monthRuns } = await admin.from("crewmate_runs").select("triage_tokens_in,triage_tokens_out,planner_tokens_in,planner_tokens_out").eq("group_id", thread.group_id).gte("started_at", monthStart.toISOString());
    const tokensUsed = (monthRuns ?? []).reduce((sum, r)=>sum + (r.triage_tokens_in ?? 0) + (r.triage_tokens_out ?? 0) + (r.planner_tokens_in ?? 0) + (r.planner_tokens_out ?? 0), 0);
    if (tokensUsed >= (group.crewmate_monthly_token_budget ?? 0)) {
      await finishRun("skipped_budget", {
        error: "monthly_token_budget_exhausted",
        tokens_used: tokensUsed
      });
      return jsonResponse({
        skipped: "budget"
      });
    }
    // No API key → fail-soft with a legible ledger reason (also the
    // deterministic local-test path).
    if (!TOGETHER_API_KEY) {
      await finishRun("failed", {
        error: "missing_together_api_key"
      });
      return jsonResponse({
        skipped: "missing_together_api_key"
      });
    }
    const together = createOpenAICompatible({
      name: "together",
      baseURL: "https://api.together.xyz/v1",
      apiKey: TOGETHER_API_KEY
    });
    // Sender household context for the system prompt.
    const { data: sender } = await admin.from("profiles").select("id,full_name").eq("id", message.sender_profile_id).single();
    const { data: membership } = await admin.from("memberships").select("household_id").eq("profile_id", message.sender_profile_id).eq("status", "active").maybeSingle();
    let householdContext = "";
    if (membership) {
      const { data: hh } = await admin.from("households").select("name").eq("id", membership.household_id).maybeSingle();
      const { data: kids } = await admin.from("children").select("first_name,last_name").eq("household_id", membership.household_id).eq("active", true);
      const { data: cars } = await admin.from("vehicles").select("label,child_passenger_capacity").eq("household_id", membership.household_id).eq("active", true);
      householdContext = [
        `Their household: ${hh?.name ?? "unknown"}.`,
        `Their children: ${(kids ?? []).map(childName).join(", ") || "none recorded"}.`,
        `Their vehicles: ${(cars ?? []).map((v)=>`${v.label} (${v.child_passenger_capacity} seats)`).join("; ") || "none"}.`
      ].join(" ");
    }
    const threadKindLabel = thread.kind === "everyone" ? "the all-parents Everyone thread" : thread.kind === "group" ? `a group chat titled "${thread.title ?? "Group"}"` : thread.kind === "agent" ? "a private conversation between the parent and Crewmate AI" : "a direct message between two parents";
    // ── Triage (skipped in private Crewmate threads: every message there
    // is addressed to the agent by definition). ──
    let triageUsage;
    let category = "question";
    let triageTopic = "";
    const { data: priorMessages } = await admin.from("chat_messages").select("id,sender_kind,sender_name,body,created_at").eq("thread_id", threadId).order("created_at", {
      ascending: false
    }).limit(MESSAGE_WINDOW);
    const transcript = [
      ...priorMessages ?? []
    ].reverse();
    if (thread.kind !== "agent" && !taggedCrewmate) {
      const triageResult = await generateText({
        model: together(TRIAGE_MODEL),
        maxOutputTokens: 1500,
        prompt: [
          `Classify the LATEST message in a parent carpool group's chat.`,
          `Latest message from ${message.sender_name}: "${message.body}"`,
          ``,
          `Recent earlier messages (for context, do not classify these):`,
          recentTranscript(transcript.slice(0, -1)),
          ``,
          `Reply with JSON only: {"category": "question" | "action" | "consent" | "chatter", "confidence": number, "topic": string}.`,
          `question: asks about the schedule, rosters, coverage, times, who drives/rides, or the weekly cycle.`,
          `action: requests a schedule change (cancel a ride, switch cars, volunteer, add a drive, change seat count).`,
          `consent: confirms or declines a pending proposal card.`,
          `chatter: social conversation or anything unrelated to the carpool schedule.`,
          ``,
          `Chatter takes priority: if the latest message is social or unrelated to rides and schedules — even when phrased as a question — it is chatter. Classify ONLY the latest message; earlier messages are context, never a category signal.`,
          `Examples of chatter (social, NOT about the schedule): "Anyone else's kid obsessed with Bluey rn" → chatter; "Great game last night!" → chatter; "Happy birthday Priya!!" → chatter; "See everyone at the potluck Saturday" → chatter; "Ugh, this traffic on 280 is brutal today" → chatter.`,
          `Example question: "Who is driving Wednesday morning?" → question. Example action: "Take Zoe off Thursday's ride" → action.`
        ].join("\n")
      });
      const parsedTriage = parseJsonish(triageResult.text);
      const triageCategory = parsedTriage?.category;
      if (triageCategory === "question" || triageCategory === "action" || triageCategory === "consent") {
        category = triageCategory;
      }
      if (parsedTriage?.topic) triageTopic = parsedTriage.topic;
      const parsedConfidence = typeof parsedTriage?.confidence === "number" ? parsedTriage.confidence : null;
      triageUsage = {
        in: triageResult.usage.promptTokens ?? triageResult.usage.inputTokens ?? 0,
        out: triageResult.usage.completionTokens ?? triageResult.usage.outputTokens ?? 0
      };
      void parsedConfidence;
      if (category === "chatter" || !parsedTriage) {
        await finishRun("chatter", {
          category,
          topic: triageTopic
        }, {
          triage: triageUsage
        });
        return jsonResponse({
          skipped: "chatter"
        });
      }
    }
    // ── In-thread consent detection (Phase 2) ──
    // When triage says consent (or a pending proposal names the sender in a
    // private thread), classify affirmative vs not; an affirmative from the
    // required confirmer executes through the server-validating RPC.
    {
      const { data: pendingForSender } = await admin.from("chat_proposals").select("id,kind,summary,required_confirmer_profile_id,thread_id").eq("thread_id", threadId).eq("status", "pending").eq("required_confirmer_profile_id", message.sender_profile_id).order("created_at", {
        ascending: false
      }).limit(1);
      const pending = (pendingForSender ?? [])[0];
      if (pending && (category === "consent" || thread.kind === "agent")) {
        const consentResult = await generateText({
          model: together(TRIAGE_MODEL),
          maxOutputTokens: 1500,
          prompt: [
            `A carpool parent may be confirming a pending proposal in chat.`,
            `The proposal card says: "${pending.summary}".`,
            `The parent's message is: "${message.body}"`,
            `Reply with JSON only: {"affirmative": true|false, "confidence": number}.`,
            `affirmative=true only if the parent clearly says yes/ok/confirmed/go ahead to that specific proposal. Declines, hesitations, or topic changes are false.`
          ].join("\n")
        });
        const consentParsed = parseJsonish(consentResult.text);
        if (consentParsed?.affirmative === true) {
          const { error: consentError } = await admin.rpc("confirm_chat_proposal_via_consent", {
            p_proposal_id: pending.id,
            p_evidence_message_id: messageId
          });
          if (!consentError) {
            await finishRun("answered", {
              via_in_thread_consent: true,
              proposal_id: pending.id,
              kind: pending.kind
            }, {
              triage: triageUsage
            });
            return jsonResponse({
              ok: true,
              via_consent: pending.id
            });
          }
          // Validation failed (stale, wrong confirmer, executor refused) —
          // fall through to the planner, which will answer in plain text.
          console.error("[chat-agent] consent rejected:", consentError?.message);
        }
      }
    }
    // ── Planner with read-only tools ──
    const ctx = {
      groupId: thread.group_id,
      senderProfileId: message.sender_profile_id,
      calls: []
    };
    const tools = {
      get_week_overview: tool({
        description: "The carpool week at a glance: every trip with its named drivers, vehicles, assigned children, and coverage. Pass week_start as a Monday in YYYY-MM-DD; omit for the current week.",
        inputSchema: z.object({
          week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
        }),
        execute: async ({ week_start })=>{
          const result = await weekOverview(ctx, admin, week_start);
          ctx.calls.push({
            name: "get_week_overview",
            args: {
              week_start
            }
          });
          return result;
        }
      }),
      get_trip_detail: tool({
        description: "Full named roster for one trip: drivers, vehicles, which child is in which car, times, and any uncovered children. service_date is YYYY-MM-DD; slot is one of am, pm_early, pm_late, custom.",
        inputSchema: z.object({
          service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          slot: z.enum([
            "am",
            "pm_early",
            "pm_late",
            "custom"
          ]).optional()
        }),
        execute: async ({ service_date, slot })=>{
          const result = await tripDetail(ctx, admin, service_date, slot);
          ctx.calls.push({
            name: "get_trip_detail",
            args: {
              service_date,
              slot
            }
          });
          return result;
        }
      }),
      get_custom_drives: tool({
        description: "Ad hoc extra drives (like a late pickup) offered by parents on one date, with remaining seats.",
        inputSchema: z.object({
          service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        }),
        execute: async ({ service_date })=>{
          const result = await customDrives(ctx, admin, service_date);
          ctx.calls.push({
            name: "get_custom_drives",
            args: {
              service_date
            }
          });
          return result;
        }
      }),
      get_household_snapshot: tool({
        description: "The asking parent's own household: adults, children, vehicles, their drives and their children's rides this week.",
        inputSchema: z.object({}),
        execute: async ()=>{
          const result = await householdSnapshot(ctx, admin);
          ctx.calls.push({
            name: "get_household_snapshot",
            args: {}
          });
          return result;
        }
      }),
      run_sql_query: tool({
        description: "Last resort for questions the other tools can't answer (e.g. counts across weeks). ONE read-only SELECT against the group's schedule tables (groups, households, children, vehicles, weeks, trips, weekly_checkins, ride_requests, driver_availability, driver_assignments, rider_assignments, schedule_versions, driver_confirmations, audit_events). No semicolons, no comments, no phone/email columns. Never call more than twice.",
        inputSchema: z.object({
          sql: z.string().min(1).max(4000)
        }),
        execute: async ({ sql })=>{
          const result = await admin.rpc("crewmate_readonly_query", {
            p_group_id: thread.group_id,
            p_sql: sql
          });
          ctx.calls.push({
            name: "run_sql_query",
            args: {
              sql
            }
          });
          if (result.error) return {
            error: result.error.message
          };
          return result.data;
        }
      })
    };
    const systemPrompt = [
      `You are Crewmate AI ☠️ — the carpool crew's first mate for "${group.name}" (meeting point: ${group.meeting_point}; school: ${group.school_name}). You ALWAYS speak like a friendly pirate. Every message must include at least one pirate expression — "aye," "ahoy matey," "arrr," "shiver me timbers," "aye aye, captain," "all aboard," "batten down the hatches" — woven naturally into the reply. Example: "Aye, three cars sail Monday morn, Wei!" or "Ahoy! Here be the Monday roster, matey:". The pirate voice is your personality, but the schedule info itself must stay crystal clear and easy to read.`,
      `Right now it is ${humanNow(group.timezone)} (${group.timezone}).`,
      `You are replying in ${threadKindLabel}, helping ${message.sender_name}. ${householdContext}`,
      ``,
      `Rules:`,
      `- Answer schedule questions from tool results. Never invent names, times, or assignments; if the tools don't answer it, say what you don't know.`,
      `- When the parent asks you to make a change the catalog supports, you MUST end your reply with the block — never merely say you will do it, never promise completion, never say a card is ready without including it. Check the facts with tools first, then end your reply with the block as the LAST lines, formatted exactly like this example (three backticks, the word crewmate, the JSON, three backticks):
\u0060\u0060\u0060crewmate
{"kind": "cancel_ride", "summary": "Cancel Max Chen's Tuesday morning ride", "params": {"child_id": "<id from tool results>", "driver_assignment_id": "<id from tool results>"}}
\u0060\u0060\u0060
Allowed kinds and params: cancel_ride {child_id, driver_assignment_id}; cancel_ride_range {child_id, from_date, to_date} for multi-day absences; switch_slot {child_id, driver_assignment_id}; add_ride {child_id, trip_id}; place_child {child_id, trip_id, driver_assignment_id}; decline_drive {assignment_id, decline_reason?}; volunteer_drive {trip_id, schedule_version_id}; swap_drive {assignment_a, assignment_b} (trading two drivers' drives — get both assignment ids first); change_vehicle {driver_assignment_id, vehicle_id}; adjust_times {trip_id, meeting_time, departure_time} (coordinator requests only); cancel_trip {trip_id} (coordinator requests only); offer_custom_drive {service_date, direction, meeting_time, child_ids}; join_custom_drive {trip_id, child_ids}; leave_custom_drive {trip_id, child_id}; cancel_custom_drive {trip_id}. Use ONLY ids that appeared in tool results. If the parent asks for something the catalog can't do, or you don't have the ids, say what you'd need. A card appears in chat — the right parent taps Confirm and only then does anything change. Never say a change has happened; say what the card proposes.`,
      `- If a parent seems to be confirming or declining a pending proposal card, ask them to use the Confirm / Decline buttons on the card itself.`,
      `- Do not share phone numbers, emails, or addresses — you don't have them, and they stay private.`,
      `- Be brief. Two to four sentences for answers, one to two for confirmations. Use children's first names and drivers' full names. A roster may be a short list, nothing longer. Format for a phone: use actual line breaks (\\n) between each driver and their car, a blank line (\\n\\n) between sections. NEVER use markdown — no **, no -, no #, no bullet symbols. The chat renders plain text only, so markdown symbols appear as ugly asterisks and dashes to parents. Just plain text with line breaks. Cut filler words, pleasantries, and repetition — parents are reading on a phone.`,
      `- If the message is social or completely unrelated to the carpool — kid TV shows, birthdays, sports, weather, traffic, school events, small talk — reply with ONLY the token NOREPLY and nothing else. Never engage, never deflect politely, never add explanation.`,
      `- Be reserved in group threads (Everyone, group chats, DMs between parents). Respond ONLY when: (a) the parent tagged you with @Crewmate, (b) the parent is clearly asking you to do something specific — a schedule change, a direct question about coverage — or (c) a parent is confirming a pending card. If parents are chatting about carpool-adjacent things with each other without directly addressing you — how the morning went, general coordination, logistics, observations — reply NOREPLY. You are a quiet crew member. Being silent when not needed is your best feature.`
    ].join("\n");
    // Reload the transcript fresh on every planning pass so coalesced
    // messages (and the agent's own earlier replies) are always in context.
    const planOnce = async ()=>{
      const { data: fresh } = await admin.from("chat_messages").select("id,sender_kind,sender_name,body,created_at").eq("thread_id", threadId).order("created_at", {
        ascending: false
      }).limit(MESSAGE_WINDOW);
      const currentTranscript = [
        ...fresh ?? []
      ].reverse();
      const result = await generateText({
        model: together(PLANNER_MODEL),
        system: systemPrompt,
        prompt: [
          `Conversation so far (oldest first):`,
          recentTranscript(currentTranscript),
          ``,
          `Reply to ${message.sender_name}'s latest message${taggedCrewmate ? " — they explicitly tagged you with @Crewmate, so respond even if it is casual: a friendly one-liner about what you can help with is perfect" : ""}.`
        ].join("\n"),
        tools,
        stopWhen: isStepCount(6),
        maxOutputTokens: 4000,
        timeout: {
          stepMs: 45_000
        }
      });
      return {
        // The final assistant text is the chat answer. Structured-output
        // modes are unreliable with Together's reasoning models (see
        // parseJsonish note); the action signal comes from triage instead.
        answer: (result.text ?? "").trim(),
        usage: {
          in: result.usage.promptTokens ?? result.usage.inputTokens ?? 0,
          out: result.usage.completionTokens ?? result.usage.outputTokens ?? 0
        }
      };
    };
    // Plan, then re-check for newer parent messages (coalesced bursts);
    // re-plan with a fresh transcript up to MAX_REPLAN_PASSES.
    let planned = await planOnce();
    for(let pass = 1; pass < MAX_REPLAN_PASSES; pass++){
      const { data: newer } = await admin.from("chat_messages").select("id").eq("thread_id", threadId).eq("sender_kind", "parent").gt("created_at", message.created_at);
      if (!newer || newer.length === 0) break;
      planned = await planOnce();
    }
    const { block, visible } = splitProposalBlock(planned.answer ?? "");
    const answer = visible.trim();

    // Second chatter gate: triage can miss chatty interrogatives on busy
    // threads, but the planner reliably recognizes off-topic. NOREPLY =
    // stay silent, exactly as if triage had caught it.
    if (!block && !taggedCrewmate && /^NOREPLY\b/i.test(answer)) {
      await finishRun("chatter", { second_gate: true, category, topic: triageTopic }, { triage: triageUsage, planner: planned.usage });
      return jsonResponse({ skipped: "chatter_second_gate" });
    }

    if (!answer && !block) {
      await finishRun("failed", {
        error: "empty_answer"
      }, {
        triage: triageUsage,
        planner: planned.usage
      });
      return jsonResponse({
        skipped: "empty_answer"
      });
    }
    // ── Phase 2: create the proposal card(s) ──
    // The model only requests a card; every fact below is re-derived from
    // the database. Required confirmers are resolved from ownership facts,
    // never from the model.
    let linkedProposalId = null;
    let proposalsCreated = 0;
    let proposalNote = "";
    if (block && typeof block.kind === "string" && PROPOSAL_CATALOG[block.kind]) {
      const entry = PROPOSAL_CATALOG[block.kind];
      const parsed = entry.schema.safeParse(block.params ?? {});
      if (!parsed.success) {
        proposalNote = " (I could not validate that request — missing or malformed details. Ask me again with the specific trip or child.)";
        console.error("[chat-agent] proposal block rejected:", parsed.error.message);
      } else {
        const params = parsed.data;
        const summary = String(block.summary ?? "").slice(0, 500);
        // Coordinator-gated kinds: only coordinators may even propose.
        if (entry.confirmer === "coordinator_asker") {
          const { data: askerMembership } = await admin.from("memberships").select("role").eq("group_id", thread.group_id).eq("profile_id", message.sender_profile_id).eq("status", "active").maybeSingle();
          if (askerMembership?.role !== "coordinator") {
            proposalNote = " (That change needs a coordinator — I can flag one if you'd like.)";
          }
        }
        if (!proposalNote) {
          if (block.kind === "admin_sql") {
            // The coordinator tier: dry-run the preview SELECT and embed
            // the affected rows on the card. Execution happens only in
            // Postgres at confirm time.
            let preview = null;
            if (typeof params.preview_sql === "string" && params.preview_sql.trim()) {
              const { data: previewRows } = await admin.rpc("crewmate_readonly_query", {
                p_group_id: thread.group_id,
                p_sql: params.preview_sql
              });
              preview = previewRows ?? {
                error: "preview failed"
              };
            }
            const { data: proposalRow, error: proposalError } = await admin.from("chat_proposals").insert({
              group_id: thread.group_id,
              thread_id: threadId,
              kind: block.kind,
              params: {
                sql: params.sql,
                preview
              },
              summary: summary || "Admin data change",
              required_confirmer_profile_id: message.sender_profile_id,
              status: "pending"
            }).select("id").single();
            if (!proposalError && proposalRow) {
              linkedProposalId = proposalRow.id;
              proposalsCreated = 1;
            } else {
              console.error("[chat-agent] admin_sql proposal insert failed:", proposalError?.message);
              proposalNote = " (I could not create that card.)";
            }
          } else if (block.kind === "swap_drive") {
            // Dual consent: two linked cards, one per driver. Nothing
            // executes until both confirm.
            const { data: daA } = await admin.from("driver_assignments").select("driver_profile_id, trip_id, status").eq("id", params.assignment_a).maybeSingle();
            const { data: daB } = await admin.from("driver_assignments").select("driver_profile_id, trip_id, status").eq("id", params.assignment_b).maybeSingle();
            const canBothSeeThread = async ()=>{
              const { count } = await admin.from("chat_participants").select("profile_id", {
                count: "exact",
                head: true
              }).eq("thread_id", threadId).in("profile_id", [
                daA?.driver_profile_id,
                daB?.driver_profile_id
              ].filter(Boolean));
              return (count ?? 0) >= 2;
            };
            if (daA && daB && daA.driver_profile_id !== daB.driver_profile_id && await canBothSeeThread()) {
              const { data: driverA } = await admin.from("profiles").select("full_name").eq("id", daA.driver_profile_id).maybeSingle();
              const { data: driverB } = await admin.from("profiles").select("full_name").eq("id", daB.driver_profile_id).maybeSingle();
              const { data: proposalB, error: errB } = await admin.from("chat_proposals").insert({
                group_id: thread.group_id,
                thread_id: threadId,
                kind: "swap_drive",
                params: {
                  assignment_a: params.assignment_a,
                  assignment_b: params.assignment_b,
                  sibling_proposal_id: null
                },
                summary: `${driverA?.full_name ?? "Driver A"} and ${driverB?.full_name ?? "Driver B"} swap these drives — this card needs ${driverB?.full_name ?? "the other driver"}'s OK too`,
                required_confirmer_profile_id: daB.driver_profile_id,
                status: "pending"
              }).select("id").single();
              if (!errB && proposalB) {
                const { data: proposalA, error: errA } = await admin.from("chat_proposals").insert({
                  group_id: thread.group_id,
                  thread_id: threadId,
                  kind: "swap_drive",
                  params: {
                    assignment_a: params.assignment_a,
                    assignment_b: params.assignment_b,
                    sibling_proposal_id: proposalB.id
                  },
                  summary: `${driverA?.full_name ?? "Driver A"} and ${driverB?.full_name ?? "Driver B"} swap these drives — this card needs ${driverA?.full_name ?? "you"}'s OK too`,
                  required_confirmer_profile_id: daA.driver_profile_id,
                  status: "pending"
                }).select("id").single();
                if (!errA && proposalA) {
                  await admin.from("chat_proposals").update({
                    params: {
                      assignment_a: params.assignment_a,
                      assignment_b: params.assignment_b,
                      sibling_proposal_id: proposalA.id
                    }
                  }).eq("id", proposalB.id);
                  linkedProposalId = proposalA.id;
                  proposalsCreated = 2;
                } else {
                  await admin.from("chat_proposals").delete().eq("id", proposalB.id);
                  console.error("[chat-agent] swap proposal A failed:", errA?.message);
                  proposalNote = " (I could not create the swap card.)";
                }
              } else {
                console.error("[chat-agent] swap proposal B failed:", errB?.message);
                proposalNote = " (I could not create the swap card.)";
              }
            } else {
              // Dual consent is useless if the other driver cannot see the
              // card: both drivers must participate in this thread.
              proposalNote = " (A swap needs a card both drivers can see — ask again in a chat you both are in, like the Everyone thread.)";
            }
          } else {
            // Single-confirmer kinds. The confirmer is resolved from
            // ownership facts; the model never picks it.
            let requiredConfirmer = null;
            if (entry.confirmer === "asker") {
              requiredConfirmer = message.sender_profile_id;
            } else if (entry.confirmer === "child_parent") {
              const childId = params.child_id;
              if (childId) {
                const { data: childRow } = await admin.from("children").select("household_id").eq("id", childId).eq("group_id", thread.group_id).maybeSingle();
                if (childRow) {
                  const { data: membershipRow } = await admin.from("memberships").select("profile_id").eq("household_id", childRow.household_id).eq("profile_id", message.sender_profile_id).eq("status", "active").maybeSingle();
                  requiredConfirmer = membershipRow?.profile_id ?? null;
                }
              }
            }
            if (!requiredConfirmer) {
              proposalNote = " (Only that child's parent can make this change — please ask them to.)";
            } else {
              const insertParams = {
                ...params
              };
              const { data: proposalRow, error: proposalError } = await admin.from("chat_proposals").insert({
                group_id: thread.group_id,
                thread_id: threadId,
                kind: block.kind,
                params: insertParams,
                summary: summary || "Schedule change",
                required_confirmer_profile_id: requiredConfirmer,
                triggered_by_message_id: messageId,
                status: "pending"
              }).select("id").single();
              if (!proposalError && proposalRow) {
                linkedProposalId = proposalRow.id;
                proposalsCreated = 1;
              } else {
                console.error("[chat-agent] proposal insert failed:", proposalError?.message);
                proposalNote = " (I could not create that card.)";
              }
            }
          }
        }
      }
    } else if (block) {
      proposalNote = " (That request is outside what I can propose right now.)";
    }
    const body = (answer + proposalNote).slice(0, MAX_AGENT_BODY) || "Done — see the card below.";
    const { data: agentMessage, error: insertError } = await admin.from("chat_messages").insert({
      thread_id: threadId,
      sender_kind: "agent",
      sender_name: "Crewmate AI",
      body,
      proposal_id: linkedProposalId
    }).select("id").single();
    if (insertError || !agentMessage) {
      await finishRun("failed", {
        error: insertError?.message ?? "insert_failed"
      }, {
        triage: triageUsage,
        planner: planned.usage
      });
      return jsonResponse({
        error: "message_insert_failed"
      }, 200);
    }
    // Push for private Crewmate threads (agent messages never trigger the
    // push trigger; everywhere else Crewmate replies stay silent).
    if (thread.kind === "agent") {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            type: "chat_message",
            thread_id: threadId,
            message_id: agentMessage.id
          })
        });
      } catch (e) {
        console.error("[chat-agent] agent-reply push failed (non-fatal):", e);
      }
    }
    // Gap-log signal: a classified CHANGE that produced no card is the
    // catalog gap that Phase 3+ should close.
    const requestedAction = proposalsCreated === 0 && category === "action" ? triageTopic || "schedule change request" : null;
    await finishRun(requestedAction ? "action_deferred" : "answered", {
      category,
      topic: triageTopic,
      requested_action: requestedAction,
      proposals_created: proposalsCreated,
      coalesced_window_ms: COALESCE_WINDOW_MS
    }, {
      triage: triageUsage,
      planner: planned.usage
    });
    // Persist the tool-call log for the gap analysis (separate update so
    // the ledger survives even if this write races).
    await admin.from("crewmate_runs").update({
      tool_calls: ctx.calls
    }).eq("id", runId);
    return jsonResponse({
      ok: true,
      message_id: agentMessage.id
    });
  } catch (e) {
    console.error("[chat-agent] run failed:", e);
    // Record the failure in the ledger so the run row never lingers as
    // 'running' (observability without dashboard access).
    if (claimedRunId) {
      try {
        await admin.from("crewmate_runs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          outcome_detail: {
            error: String(e?.message ?? e).slice(0, 500)
          }
        }).eq("id", claimedRunId);
      } catch  {
      // never error from the error path
      }
    }
    return jsonResponse({
      error: "agent_failed"
    }, 200); // never error to pg_net
  }
});
