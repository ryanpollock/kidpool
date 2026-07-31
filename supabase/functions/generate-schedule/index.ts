// Edge Function: generate-schedule
// Invoked by a coordinator to produce a versioned draft schedule for a week.
// Reads the week's trips, check-ins, ride requests, driver availability,
// vehicles, children, and existing assignments; runs the pure greedy-v1
// algorithm; writes a new schedule_version with tentative driver and rider
// assignments in a single transaction.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { generateSchedule, ALGORITHM_VERSION } from "../_shared/scheduling/greedy-v1.ts";
import type {
  SchedulingAssignment,
  SchedulingAvailability,
  SchedulingChild,
  SchedulingInputs,
  SchedulingProfile,
  SchedulingRideRequest,
  SchedulingTrip,
  SchedulingVehicle,
} from "../_shared/scheduling/types.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { weekId } = await req.json();
    if (!weekId || typeof weekId !== "string") {
      return jsonError("Missing weekId.", 400);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return jsonError("Authentication required.", 401);
    }
    const userId = userData.user.id;

    const { data: weekRow, error: weekError } = await supabase
      .from("weeks")
      .select("id, group_id")
      .eq("id", weekId)
      .maybeSingle();
    if (weekError || !weekRow) {
      return jsonError("Week not found.", 404);
    }
    const groupId = weekRow.group_id;

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

    const [tripsRes, checkinsRes, rideRequestsRes, availabilityRes, vehiclesRes, childrenRes, membershipsRes] = await Promise.all([
      supabase.from("trips").select("id, service_date, direction, week_id, group_id").eq("week_id", weekId).eq("group_id", groupId).order("service_date").order("direction"),
      supabase.from("weekly_checkins").select("id, household_id, max_drives").eq("week_id", weekId).eq("group_id", groupId),
      supabase.from("ride_requests").select("trip_id, child_id, needs_ride, group_id").in("trip_id", tripsRes.data?.map((t: { id: string }) => t.id) ?? []),
      supabase.from("driver_availability").select("trip_id, driver_profile_id, vehicle_id, preference, group_id").in("trip_id", tripsRes.data?.map((t: { id: string }) => t.id) ?? []),
      supabase.from("vehicles").select("id, household_id, label, child_passenger_capacity, active, group_id").eq("group_id", groupId).eq("active", true),
      supabase.from("children").select("id, household_id, first_name, last_name, active, group_id").eq("group_id", groupId).eq("active", true),
      supabase.from("memberships").select("profile_id, household_id, status, group_id").eq("group_id", groupId).eq("status", "active"),
    ]);

    if (tripsRes.error || !tripsRes.data) return jsonError("Failed to load trips.", 500);

    const profileIds = (membershipsRes.data ?? []).map((m: { profile_id: string }) => m.profile_id);
    const profilesRes = profileIds.length
      ? await supabase.from("profiles").select("id, full_name").in("id", profileIds)
      : { data: [], error: null };

    const profileHouseholdMap = new Map<string, string>();
    for (const m of (membershipsRes.data ?? []) as Array<{ profile_id: string; household_id: string }>) {
      profileHouseholdMap.set(m.profile_id, m.household_id);
    }

    const profiles: SchedulingProfile[] = (profilesRes.data ?? []).map((p: { id: string; full_name: string }) => ({
      id: p.id,
      full_name: p.full_name,
      household_id: profileHouseholdMap.get(p.id) ?? "",
    }));

    const trips: SchedulingTrip[] = (tripsRes.data ?? []).map((t) => ({
      id: t.id,
      service_date: t.service_date,
      direction: t.direction,
    }));

    const children: SchedulingChild[] = (childrenRes.data ?? []).map((c) => ({
      id: c.id,
      household_id: c.household_id,
      first_name: c.first_name,
      last_name: c.last_name,
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
    }));

    const availability: SchedulingAvailability[] = (availabilityRes.data ?? []).map((a) => ({
      trip_id: a.trip_id,
      driver_profile_id: a.driver_profile_id,
      vehicle_id: a.vehicle_id,
      preference: a.preference,
    }));

    const maxDrivesByDriver = new Map<string, number>();
    for (const c of (checkinsRes.data ?? []) as Array<{ household_id: string; max_drives: number }>) {
      for (const [profileId, householdId] of profileHouseholdMap) {
        if (householdId === c.household_id) {
          maxDrivesByDriver.set(profileId, c.max_drives);
        }
      }
    }

    let existingAssignments: SchedulingAssignment[] = [];
    let nextVersionNumber = 1;
    const { data: latestVersion } = await supabase
      .from("schedule_versions")
      .select("id, version_number, status")
      .eq("week_id", weekId)
      .eq("group_id", groupId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestVersion && latestVersion.id) {
      nextVersionNumber = latestVersion.version_number + 1;
      const { data: priorDriverAssignments } = await supabase
        .from("driver_assignments")
        .select("id, trip_id, driver_profile_id, vehicle_id, child_passenger_capacity, status")
        .eq("schedule_version_id", latestVersion.id)
        .eq("group_id", groupId);

      existingAssignments = (priorDriverAssignments ?? []).map((a) => ({
        driver_profile_id: a.driver_profile_id,
        household_id: profileHouseholdMap.get(a.driver_profile_id) ?? "",
        vehicle_id: a.vehicle_id,
        child_passenger_capacity: a.child_passenger_capacity,
        confirmed: a.status === "confirmed",
      }));
    }

    const inputs: SchedulingInputs = {
      trips,
      children,
      vehicles,
      profiles,
      rideRequests,
      availability,
      maxDrivesByDriver,
      existingAssignments,
    };

    const outputs = generateSchedule(inputs);

    const { data: newVersion, error: versionError } = await supabase
      .from("schedule_versions")
      .insert({
        group_id: groupId,
        week_id: weekId,
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

    if (latestVersion && latestVersion.id) {
      await supabase
        .from("schedule_versions")
        .update({ status: "superseded" })
        .eq("id", latestVersion.id);
    }

    for (const tripResult of outputs.trips) {
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

        if (driverError || !driverAssignment) continue;

        if (assignment.assigned_child_ids.length > 0) {
          const riderInserts = assignment.assigned_child_ids.map((childId) => ({
            group_id: groupId,
            schedule_version_id: newVersion.id,
            trip_id: tripResult.trip_id,
            driver_assignment_id: driverAssignment.id,
            child_id: childId,
          }));
          await supabase.from("rider_assignments").insert(riderInserts);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: newVersion,
        algorithm: ALGORITHM_VERSION,
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