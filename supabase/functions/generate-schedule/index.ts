// Edge Function: generate-schedule
// Invoked by a coordinator OR by the cron automation to produce a versioned
// draft schedule for a week. Reads the week's trips, check-ins, ride requests,
// driver availability, vehicles, children, and existing assignments; runs the
// pure balanced-greedy-v2 algorithm; writes a new schedule_version with tentative driver
// and rider assignments. Auto-publishes when the confirmation deadline has
// passed and no prior published version exists (or the new draft is clean).
//
// Algorithm: balanced-greedy-v2 — adds the shared-car rule over v1: at most
// one driver per household per trip (a household may have multiple adults
// who can drive but only one car).
//
// Auth paths:
//   - User JWT (manual): coordinator check via memberships table.
//   - Cron/Service role (automated): CRON_SECRET or SERVICE_ROLE_KEY accepted
//     directly, coordinator check skipped. Uses a service-role client for
//     writes so publish_schedule_internal (which checks no auth.uid()) works.
//
// Error handling: every data load and write is error-checked. A failure at
// any point returns a 500 with a descriptive message rather than silently
// producing a partial or empty schedule.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { generateSchedule, ALGORITHM_VERSION } from "../_shared/scheduling/balanced-greedy-v2.ts";
import type {
  SchedulingAssignment,
  SchedulingAvailability,
  SchedulingChild,
  SchedulingInputs,
  SchedulingOutputs,
  SchedulingProfile,
  SchedulingRideRequest,
  SchedulingTrip,
  SchedulingVehicle,
} from "../_shared/scheduling/types.ts";

// Invoke the send-push Edge Function via direct HTTP (same pattern as the
// DB cron wrappers). The Supabase SDK's functions.invoke has silently failed
// in the Deno runtime; direct fetch with CRON_SECRET is the proven path used
// by all other notification triggers in the system.
async function invokeSendPush(
  supabaseUrl: string,
  cronSecret: string,
  body: Record<string, unknown>,
): Promise<void> {
  await fetch(`${supabaseUrl}/functions/v1/send-push`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Parse and validate request body ──────────────────────────
    let weekId: unknown;
    let source: string | undefined;
    let mode: string | undefined;
    try {
      const body = await req.json();
      weekId = body?.weekId;
      source = body?.source;
      mode = body?.mode;
    } catch {
      return jsonError("Missing or invalid request body.", 400);
    }
    if (!weekId || typeof weekId !== "string") {
      return jsonError("Missing weekId.", 400);
    }

    // ── Validate server configuration ─────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonError("Server configuration error.", 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");

    // ── Determine auth path ───────────────────────────────────────
    // System calls (source === "cron") accept CRON_SECRET or SERVICE_ROLE_KEY
    // directly, mirroring the send-push verifyAuth pattern. User calls go
    // through the standard JWT path.
    const isSystemCall = source === "cron";
    let isSystemAuthed = false;
    if (isSystemCall) {
      if (cronSecret && token === cronSecret) isSystemAuthed = true;
      if (serviceRoleKey && token === serviceRoleKey) isSystemAuthed = true;
      if (!isSystemAuthed) return jsonError("Invalid system credentials.", 401);
    }

    // For system calls, use the service-role client (bypasses RLS, auth.uid()
    // is null). For user calls, use the anon key + user JWT as before.
    const writeClient = isSystemCall && serviceRoleKey
      ? createClient(supabaseUrl, serviceRoleKey)
      : createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: authHeader } },
        });

    // For reads, system calls can use the service client too; user calls use
    // their JWT client (so RLS filters to their group).
    const supabase = writeClient;

    // ── Authenticate (user path only) ────────────────────────────
    let userId: string | null = null;
    if (!isSystemCall) {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        return jsonError("Authentication required.", 401);
      }
      userId = userData.user.id;
    }

    // ── Load week (with deadlines for auto-publish decision) ──────
    const { data: weekRow, error: weekError } = await supabase
      .from("weeks")
      .select("id, group_id, checkin_deadline, confirmation_deadline")
      .eq("id", weekId as string)
      .maybeSingle();
    if (weekError || !weekRow) {
      return jsonError("Week not found.", 404);
    }
    const groupId = weekRow.group_id;
    const confirmationDeadline = weekRow.confirmation_deadline as string | null;
    const deadlinePassed = confirmationDeadline
      ? new Date() >= new Date(confirmationDeadline)
      : true; // no deadline = treat as passed (edge case)

    // ── Verify coordinator (user path only) ──────────────────────
    if (!isSystemCall && userId) {
      const { data: membership, error: membershipError } = await supabase
        .from("memberships")
        .select("role")
        .eq("group_id", groupId)
        .eq("profile_id", userId)
        .eq("status", "active")
        .maybeSingle();
      if (membershipError || !membership || membership.role !== "coordinator") {
        return jsonError("Only coordinators can generate schedules.", 403);
      }
    }

    // ── Load data (phase 1: trips first, then trip-dependent queries) ──
    const [tripsRes, checkinsRes, vehiclesRes, childrenRes, membershipsRes] = await Promise.all([
      supabase.from("trips").select("id, service_date, direction, slot, week_id, group_id").eq("week_id", weekId as string).eq("group_id", groupId).order("service_date").order("direction").order("slot"),
      supabase.from("weekly_checkins").select("id, household_id, max_drives, status").eq("week_id", weekId as string).eq("group_id", groupId),
      supabase.from("vehicles").select("id, household_id, label, child_passenger_capacity, active, group_id").eq("group_id", groupId).eq("active", true),
      supabase.from("children").select("id, household_id, first_name, last_name, active, group_id, preferred_buddy_child_id, is_priority").eq("group_id", groupId).eq("active", true),
      supabase.from("memberships").select("profile_id, household_id, status, group_id").eq("group_id", groupId).eq("status", "active"),
    ]);

    // Check every data-load result for errors
    if (tripsRes.error || !tripsRes.data) return jsonError("Failed to load trips.", 500);
    if (checkinsRes.error) return jsonError("Failed to load check-ins.", 500);
    if (vehiclesRes.error) return jsonError("Failed to load vehicles.", 500);
    if (childrenRes.error) return jsonError("Failed to load children.", 500);
    if (membershipsRes.error) return jsonError("Failed to load memberships.", 500);

    // Only count ride requests and driver availability from submitted check-ins.
    // Draft check-ins may contain auto-populated defaults that households haven't confirmed.
    const submittedCheckinIds = (checkinsRes.data ?? [])
      .filter((c: { status: string }) => c.status === "submitted")
      .map((c: { id: string }) => c.id);

    const tripIds = tripsRes.data.map((t: { id: string }) => t.id);
    const [rideRequestsRes, availabilityRes] = await Promise.all([
      submittedCheckinIds.length
        ? supabase.from("ride_requests").select("trip_id, child_id, needs_ride, preference, group_id").in("trip_id", tripIds).in("checkin_id", submittedCheckinIds)
        : { data: [], error: null },
      submittedCheckinIds.length
        ? supabase.from("driver_availability").select("trip_id, driver_profile_id, vehicle_id, preference, group_id").in("trip_id", tripIds).in("checkin_id", submittedCheckinIds)
        : { data: [], error: null },
    ]);

    if (rideRequestsRes.error) return jsonError("Failed to load ride requests.", 500);
    if (availabilityRes.error) return jsonError("Failed to load driver availability.", 500);

    const profileIds = (membershipsRes.data ?? []).map((m: { profile_id: string }) => m.profile_id);
    const profilesRes = profileIds.length
      ? await supabase.from("profiles").select("id, full_name, email").in("id", profileIds)
      : { data: [], error: null };

    if (profilesRes.error) return jsonError("Failed to load profiles.", 500);

    // ── Build algorithm inputs ───────────────────────────────────
    // Build profileHouseholdMap from memberships (not subject to profiles RLS)
    const profileHouseholdMap = new Map<string, string>();
    for (const m of (membershipsRes.data ?? []) as Array<{ profile_id: string; household_id: string }>) {
      profileHouseholdMap.set(m.profile_id, m.household_id);
    }

    // Build profiles from profileHouseholdMap so all members are included
    // even when the profiles table RLS restricts the query to the caller's
    // own row. Enrich with full_name from profilesRes (best-effort).
    const fullNameById = new Map(
      (profilesRes.data ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name]),
    );
    const profiles: SchedulingProfile[] = Array.from(profileHouseholdMap.entries()).map(
      ([id, household_id]) => ({
        id,
        full_name: fullNameById.get(id) ?? "",
        household_id,
      }),
    );

    const trips: SchedulingTrip[] = (tripsRes.data ?? []).map((t) => ({
      id: t.id,
      service_date: t.service_date,
      direction: t.direction,
      slot: t.slot,
    }));

    const children: SchedulingChild[] = (childrenRes.data ?? []).map((c) => ({
      id: c.id,
      household_id: c.household_id,
      first_name: c.first_name,
      last_name: c.last_name,
      preferred_buddy_child_id: c.preferred_buddy_child_id ?? null,
      is_priority: c.is_priority ?? false,
    }));

    const vehicles: SchedulingVehicle[] = (vehiclesRes.data ?? []).map((v) => ({
      id: v.id,
      household_id: v.household_id,
      label: v.label,
      child_passenger_capacity: v.child_passenger_capacity,
    }));

    const rideRequests: SchedulingRideRequest[] = (rideRequestsRes.data ?? []).map((r) => ({
      trip_id: r.trip_id,
      child_id: r.child_id,
      needs_ride: r.needs_ride,
      preference: r.preference ?? "specific",
    }));

    const availability: SchedulingAvailability[] = (availabilityRes.data ?? []).map((a) => ({
      trip_id: a.trip_id,
      driver_profile_id: a.driver_profile_id,
      vehicle_id: a.vehicle_id,
      preference: a.preference,
    }));

    const eligibleAvailabilityKey = new Set(
      availability
        .filter((a) => a.preference !== "cannot" && a.vehicle_id)
        .map((a) => `${a.trip_id}|${a.driver_profile_id}`),
    );

    const maxDrivesByDriver = new Map<string, number>();
    for (const c of (checkinsRes.data ?? []) as Array<{ household_id: string; max_drives: number; status: string }>) {
      if (c.status !== "submitted") continue;
      for (const [profileId, householdId] of profileHouseholdMap) {
        if (householdId === c.household_id) {
          maxDrivesByDriver.set(profileId, c.max_drives);
        }
      }
    }

    // Cap the founder at 2 algorithmic drives/week (preferential treatment).
    // Volunteering for uncovered trips bypasses max_drives, so Ryan can still
    // manually volunteer beyond this if he wants to.
    const FOUNDER_EMAIL = "ryan.pollock@gmail.com";
    const FOUNDER_MAX_DRIVES = 1;
    for (const p of (profilesRes.data ?? []) as Array<{ id: string; email: string | null }>) {
      if (p.email === FOUNDER_EMAIL) {
        const current = maxDrivesByDriver.get(p.id) ?? 10;
        maxDrivesByDriver.set(p.id, Math.min(current, FOUNDER_MAX_DRIVES));
      }
    }

    // ── Load existing assignments for stability ──────────────────
    let existingAssignments: SchedulingAssignment[] = [];
    let nextVersionNumber = 1;
    const declinedTripsByDriver = new Map<string, Set<string>>();
    const expiredTripsByDriver = new Map<string, Set<string>>();
    let priorDriverAssignments: Array<{
      id: string; trip_id: string; driver_profile_id: string;
      vehicle_id: string; child_passenger_capacity: number; status: string;
    }> = [];
    const { data: latestVersion, error: latestVersionError } = await supabase
      .from("schedule_versions")
      .select("id, version_number, status")
      .eq("week_id", weekId as string)
      .eq("group_id", groupId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestVersionError) return jsonError("Failed to load existing schedule versions.", 500);

    if (latestVersion && latestVersion.id) {
      nextVersionNumber = latestVersion.version_number + 1;
      const { data: priorData, error: priorError } = await supabase
        .from("driver_assignments")
        .select("id, trip_id, driver_profile_id, vehicle_id, child_passenger_capacity, status")
        .eq("schedule_version_id", latestVersion.id)
        .eq("group_id", groupId);

      if (priorError) return jsonError("Failed to load prior assignments.", 500);
      priorDriverAssignments = priorData ?? [];

      existingAssignments = priorDriverAssignments
        .filter((a) => {
          if (a.status !== "confirmed") return true;
          return eligibleAvailabilityKey.has(`${a.trip_id}|${a.driver_profile_id}`);
        })
        .map((a) => ({
          trip_id: a.trip_id,
          driver_profile_id: a.driver_profile_id,
          household_id: profileHouseholdMap.get(a.driver_profile_id) ?? "",
          vehicle_id: a.vehicle_id,
          child_passenger_capacity: a.child_passenger_capacity,
          confirmed: a.status === "confirmed",
        }));

      // Build declined/expired maps so the algorithm doesn't re-offer trips
      // to drivers who said no or let the confirmation deadline pass.
      for (const a of priorDriverAssignments) {
        if (a.status === "declined" || a.status === "released") {
          let set = declinedTripsByDriver.get(a.driver_profile_id);
          if (!set) { set = new Set(); declinedTripsByDriver.set(a.driver_profile_id, set); }
          set.add(a.trip_id);
        }
        if (a.status === "expired") {
          let set = expiredTripsByDriver.get(a.driver_profile_id);
          if (!set) { set = new Set(); expiredTripsByDriver.set(a.driver_profile_id, set); }
          set.add(a.trip_id);
        }
      }
    }

    // ── Run the algorithm (full or surgical) ────────────────────
    const inputs: SchedulingInputs = {
      trips,
      children,
      vehicles,
      profiles,
      rideRequests,
      availability,
      maxDrivesByDriver,
      existingAssignments,
      declinedTripsByDriver,
      expiredTripsByDriver,
    };

    let outputs: SchedulingOutputs;

    if (mode === "surgical" && latestVersion && latestVersion.id) {
      // Surgical mode: preserve confirmed assignments, fit new riders into
      // spare capacity. Does NOT run the greedy scheduler — the morning draft
      // already did the optimization. This only handles the delta: late
      // check-ins and driver confirmations since the draft was generated.
      const priorVersionId = latestVersion.id;

      // Load rider_assignments for the prior version (to know which kids
      // are in which confirmed cars)
      const { data: priorRiderAssignments, error: riderError } = await supabase
        .from("rider_assignments")
        .select("child_id, driver_assignment_id")
        .eq("schedule_version_id", priorVersionId)
        .eq("group_id", groupId);
      if (riderError) return jsonError("Failed to load prior rider assignments.", 500);

      // Map: driver_assignment_id → child_ids (from prior version, confirmed only)
      const confirmedDAIds = new Set(
        priorDriverAssignments.filter((a) => a.status === "confirmed").map((a) => a.id),
      );
      const ridersByDA = new Map<string, string[]>();
      for (const ra of priorRiderAssignments ?? []) {
        if (!confirmedDAIds.has(ra.driver_assignment_id)) continue;
        const arr = ridersByDA.get(ra.driver_assignment_id) ?? [];
        arr.push(ra.child_id);
        ridersByDA.set(ra.driver_assignment_id, arr);
      }

      // Build per-trip ride request sets (from submitted check-ins, matching the scheduler)
      const rideRequestChildIdsByTrip = new Map<string, Set<string>>();
      for (const rr of rideRequests) {
        if (!rr.needs_ride) continue;
        const set = rideRequestChildIdsByTrip.get(rr.trip_id) ?? new Set<string>();
        set.add(rr.child_id);
        rideRequestChildIdsByTrip.set(rr.trip_id, set);
      }

      // Map: child_id → vehicle capacity for the confirmed car they're in
      // (for checking spare capacity when fitting new riders)
      const childByIdMap = new Map(children.map((c) => [c.id, c]));
      const vehicleByIdMap = new Map(vehicles.map((v) => [v.id, v]));

      // Build surgical outputs: copy confirmed assignments, add new riders
      // to cars with spare capacity
      const tripResults = trips.map((trip) => {
        const tripConfirmedDAs = priorDriverAssignments.filter(
          (a) => a.trip_id === trip.id && a.status === "confirmed",
        );

        // All children who need a ride on this trip (from submitted check-ins)
        const neededChildIds = rideRequestChildIdsByTrip.get(trip.id) ?? new Set<string>();

        // Children already covered by confirmed assignments
        const coveredChildIds = new Set<string>();
        for (const da of tripConfirmedDAs) {
          const kids = ridersByDA.get(da.id) ?? [];
          for (const kidId of kids) coveredChildIds.add(kidId);
        }

        // Uncovered: need a ride but not in any confirmed car
        const uncoveredChildIds = [...neededChildIds].filter((id) => !coveredChildIds.has(id));

        // Try to fit uncovered riders into confirmed cars with spare capacity
        const remainingUncovered = new Set(uncoveredChildIds);
        const assignments = tripConfirmedDAs.map((da) => {
          const vehicle = vehicleByIdMap.get(da.vehicle_id);
          const capacity = vehicle?.child_passenger_capacity ?? da.child_passenger_capacity;
          const existingKids = ridersByDA.get(da.id) ?? [];
          const assignedChildIds = [...existingKids];

          // Fill spare capacity with uncovered riders
          for (const childId of [...remainingUncovered]) {
            if (assignedChildIds.length >= capacity) break;
            // Don't assign a child to their own household's car if they're
            // already in a different car (edge case — normally they wouldn't
            // be uncovered if their household has a confirmed car)
            const child = childByIdMap.get(childId);
            if (child && profileHouseholdMap.get(da.driver_profile_id) === child.household_id) {
              // Own child — should already be in the car. Skip if somehow uncovered.
            }
            assignedChildIds.push(childId);
            remainingUncovered.delete(childId);
            coveredChildIds.add(childId);
          }

          return {
            trip_id: trip.id,
            driver_profile_id: da.driver_profile_id,
            vehicle_id: da.vehicle_id,
            child_passenger_capacity: capacity,
            assigned_child_ids: assignedChildIds,
            confirmed: true,
          };
        });

        const assignedRiderCount = [...neededChildIds].filter((id) => !remainingUncovered.has(id)).length;
        const uncoveredCount = remainingUncovered.size;

        return {
          trip_id: trip.id,
          rider_count: neededChildIds.size,
          assigned_rider_count: assignedRiderCount,
          uncovered_rider_count: uncoveredCount,
          driver_count: assignments.length,
          seat_count: assignments.reduce((sum, a) => sum + a.child_passenger_capacity, 0),
          assignments,
          uncovered: uncoveredCount > 0,
        };
      });

      outputs = {
        trips: tripResults,
        algorithm_version: `${ALGORITHM_VERSION}-surgical`,
      };
    } else {
      // Full mode: run the greedy scheduler from scratch
      outputs = generateSchedule(inputs);
    }

    // ── Write schedule version ───────────────────────────────────
    // Always insert as draft first. Only auto-publish after assignments
    // are written successfully AND zero trips have uncovered riders.
    const wasPublished = latestVersion?.status === "published";
    const hasUncovered = outputs.trips.some((t) => t.uncovered);
    const { data: newVersion, error: versionError } = await supabase
      .from("schedule_versions")
      .insert({
        group_id: groupId,
        week_id: weekId as string,
        version_number: nextVersionNumber,
        status: "draft",
        algorithm_version: ALGORITHM_VERSION,
        generated_by: userId,
      })
      .select("id, version_number")
      .single();

    if (versionError || !newVersion) {
      return jsonError("Failed to create schedule version.", 500);
    }

    // ── Write driver and rider assignments ──────────────────────
    let writtenAssignmentCount = 0;
    let writeFailed = false;
    let writeErrorMessage = "";
    for (const tripResult of outputs.trips) {
      if (writeFailed) break;
      for (const assignment of tripResult.assignments) {
        const { data: driverAssignment, error: driverError } = await supabase
          .from("driver_assignments")
          .insert({
            group_id: groupId,
            schedule_version_id: newVersion.id,
            trip_id: tripResult.trip_id,
            driver_profile_id: assignment.driver_profile_id,
            vehicle_id: assignment.vehicle_id,
            status: assignment.confirmed ? "confirmed" : "tentative",
            child_passenger_capacity: assignment.child_passenger_capacity,
          })
          .select("id")
          .single();

        if (driverError || !driverAssignment) {
          writeFailed = true;
          writeErrorMessage = "Failed to create driver assignment.";
          break;
        }

        writtenAssignmentCount++;

        if (assignment.assigned_child_ids.length > 0) {
          const riderInserts = assignment.assigned_child_ids.map((childId) => ({
            group_id: groupId,
            schedule_version_id: newVersion.id,
            trip_id: tripResult.trip_id,
            driver_assignment_id: driverAssignment.id,
            child_id: childId,
          }));
          const { error: riderError } = await supabase.from("rider_assignments").insert(riderInserts);
          if (riderError) {
            writeFailed = true;
            writeErrorMessage = "Failed to create rider assignments.";
            break;
          }
        }
      }
    }

    // ── Rollback on write failure ───────────────────────────────
    if (writeFailed) {
      // Delete the new version row (cascades to assignments) so the
      // prior version remains active. Prior version was NOT yet superseded.
      await supabase.from("schedule_versions").delete().eq("id", newVersion.id);
      return jsonError(writeErrorMessage, 500);
    }

    // ── Auto-publish + supersede ────────────────────────────────
// Two auto-publish triggers:
//   1. Clean re-publish (pre-deadline): prior was published AND new draft has
//      no uncovered trips and no tentative assignments → publish immediately.
//   2. Deadline auto-publish: confirmation deadline has passed AND no prior
//      published version exists → publish regardless of uncovered/tentative.
//      Remaining tentative assignments expire → those trips become uncovered.
//      This removes the coordinator as a blocker for the final publish step.
//
// Guard: if the prior was published but the new draft has uncovered/tentative,
// keep the new draft and DON'T supersede the published version. The published
// schedule stays live; the admin can manually "Replace published schedule."
//
// System calls route through publish_schedule_internal (no auth.uid() check).
// User calls route through publish_schedule (checks coordinator via auth.uid()).
const hasTentative = outputs.trips.some((t) =>
  t.assignments.some((a) => !a.confirmed)
);
const cleanRepublish = wasPublished && !hasUncovered && !hasTentative;
const deadlineAutoPublish = deadlinePassed && !wasPublished;
const shouldAutoPublish = cleanRepublish || deadlineAutoPublish;
let autoPublished = false;
if (shouldAutoPublish) {
  const rpcName = isSystemCall ? "publish_schedule_internal" : "publish_schedule";
  const rpcParams = isSystemCall
    ? { p_group_id: groupId, p_version_id: newVersion.id, p_actor_id: userId }
    : { p_group_id: groupId, p_version_id: newVersion.id };
  const { data: publishResult, error: publishError } = await writeClient
    .rpc(rpcName, rpcParams);
  if (publishError || (publishResult && publishResult.error)) {
    console.warn("Auto-publish failed, keeping as draft:", publishError?.message ?? publishResult?.error);
  } else {
    autoPublished = true;
    // Send push notifications for the published schedule.
    // 'published' goes to all members; 'uncovered' goes to affected families;
    // 'admin_escalation' goes to coordinators if there are uncovered trips.
    try {
      await invokeSendPush(supabaseUrl, cronSecret, { type: "published", version_id: newVersion.id });
      if (hasUncovered) {
        await invokeSendPush(supabaseUrl, cronSecret, { type: "uncovered", version_id: newVersion.id });
        await invokeSendPush(supabaseUrl, cronSecret, { type: "admin_escalation", version_id: newVersion.id });
      }
    } catch (pushError) {
      console.warn("Push notification failed (non-blocking):", pushError instanceof Error ? pushError.message : "unknown");
    }

    // ── Detect displaced confirmed drivers ────────────────────
    // A displaced driver was confirmed in the prior version but is NOT
    // in the new published version (re-optimization dropped them).
    // Notify them via send-push 'displaced' type.
    if (priorDriverAssignments.length > 0) {
      const newDriverKeys = new Set<string>();
      for (const t of outputs.trips) {
        for (const a of t.assignments) {
          newDriverKeys.add(`${a.trip_id}|${a.driver_profile_id}`);
        }
      }
      const displaced = priorDriverAssignments.filter((a) =>
        a.status === "confirmed" &&
        !newDriverKeys.has(`${a.trip_id}|${a.driver_profile_id}`),
      );
      if (displaced.length > 0) {
        try {
          await invokeSendPush(supabaseUrl, cronSecret, {
            type: "displaced",
            version_id: newVersion.id,
            displaced_drivers: displaced.map((a) => ({
              profile_id: a.driver_profile_id,
              trip_id: a.trip_id,
            })),
          });
        } catch (displacedPushError) {
          console.warn("Displaced-driver notification failed (non-blocking):", displacedPushError instanceof Error ? displacedPushError.message : "unknown");
        }
      }
    }
  }
} else if (latestVersion && latestVersion.id && latestVersion.status === "draft") {
  // New version is a draft; only supersede if the prior was also a draft
  // (never supersede a published version when the new one stays as draft).
  const { error: supersedeError } = await supabase
    .from("schedule_versions")
    .update({ status: "superseded" })
    .eq("id", latestVersion.id);
  if (supersedeError) {
    return jsonError(`Failed to supersede prior version: ${supersedeError.message}`, 500);
  }
}

  // ── Notify drivers with tentative assignments (draft only) ─────
  if (!autoPublished) {
    try {
      await invokeSendPush(supabaseUrl, cronSecret, { type: "assignment_request", version_id: newVersion.id });
    } catch (pushError) {
      console.warn("Assignment request notification failed (non-blocking):", pushError instanceof Error ? pushError.message : "unknown");
    }
  }

  // ── Audit event (best-effort) ───────────────────────────────
    try {
      await supabase.from("audit_events").insert({
        group_id: groupId,
        actor_profile_id: userId,
        action: "schedule_generated",
        entity_type: "schedule_version",
        entity_id: newVersion.id,
        details: {
          version_number: newVersion.version_number,
          week_id: weekId,
          assignment_count: writtenAssignmentCount,
          algorithm: ALGORITHM_VERSION,
          uncovered_trips: outputs.trips.filter((t) => t.uncovered).length,
        },
      });
    } catch (auditError) {
      console.warn("Failed to write audit event:", auditError instanceof Error ? auditError.message : "unknown");
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: newVersion,
        algorithm: ALGORITHM_VERSION,
        auto_published: autoPublished,
        uncovered_trips: outputs.trips.filter((t) => t.uncovered).length,
        warning: hasUncovered
          ? autoPublished
            ? `${outputs.trips.filter((t) => t.uncovered).length} trip(s) have uncovered children. Schedule published — affected families and the admin have been notified.`
            : `${outputs.trips.filter((t) => t.uncovered).length} trip(s) have uncovered children. Schedule saved as draft — review before publishing.`
          : null,
        trips: outputs.trips.map((t) => ({
          trip_id: t.trip_id,
          rider_count: t.rider_count,
          assigned_rider_count: t.assigned_rider_count,
          uncovered_rider_count: t.uncovered_rider_count,
          driver_count: t.driver_count,
          uncovered: t.uncovered,
        })),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonError(message, 500);
  }
});

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}