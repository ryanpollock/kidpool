// Pure deterministic greedy scheduler, version 1.
// Zero imports so it runs in both Deno (Edge Function) and Node (tests).
// To swap in a better algorithm later, add a new module and select by version.

import type {
  SchedulingAssignment,
  SchedulingAvailability,
  SchedulingChild,
  SchedulingDriverAssignment,
  SchedulingInputs,
  SchedulingOutputs,
  SchedulingTrip,
  SchedulingTripResult,
  SchedulingVehicle,
  SchedulingProfile,
} from "./types.ts";

export const ALGORITHM_VERSION = "greedy-v1";

function tripSortKey(trip: SchedulingTrip): string {
  return `${trip.service_date}|${trip.direction === "morning" ? "0" : "1"}`;
}

function childSortKey(child: SchedulingChild): string {
  const priorityPrefix = child.is_priority ? "0" : "1";
  return `${priorityPrefix}|${child.household_id}|${child.first_name}|${child.last_name}|${child.id}`;
}

function driverPreferenceRank(pref: string): number {
  if (pref === "prefer") return 0;
  if (pref === "can") return 1;
  return 2;
}

export function generateSchedule(inputs: SchedulingInputs): SchedulingOutputs {
  const sortedTrips = [...inputs.trips].sort((a, b) =>
    tripSortKey(a).localeCompare(tripSortKey(b)),
  );

  const childById = new Map(inputs.children.map((c) => [c.id, c]));
  const vehicleById = new Map(inputs.vehicles.map((v) => [v.id, v]));
  const householdByProfileId = new Map(
    inputs.profiles.map((p) => [p.id, p.household_id]),
  );

  const confirmedAssignmentsByTrip = new Map<
    string,
    SchedulingAssignment[]
  >();
  for (const assignment of inputs.existingAssignments) {
    if (!assignment.confirmed) continue;
    const existing = confirmedAssignmentsByTrip.get(assignment.trip_id) ?? [];
    existing.push(assignment);
    confirmedAssignmentsByTrip.set(assignment.trip_id, existing);
  }

  const assignmentsThisWeek = new Map<string, number>();
  for (const a of inputs.existingAssignments) {
    if (a.confirmed) {
      assignmentsThisWeek.set(
        a.driver_profile_id,
        (assignmentsThisWeek.get(a.driver_profile_id) ?? 0) + 1,
      );
    }
  }

  const tripResults: SchedulingTripResult[] = [];

  for (const trip of sortedTrips) {
    const riders = inputs.rideRequests
      .filter((r) => r.trip_id === trip.id && r.needs_ride)
      .map((r) => childById.get(r.child_id))
      .filter((c): c is SchedulingChild => c !== undefined)
      .sort((a, b) => childSortKey(a).localeCompare(childSortKey(b)));

    const eligibleAvailability = inputs.availability.filter(
      (a): a is SchedulingAvailability & { vehicle_id: string } =>
        a.trip_id === trip.id &&
        a.preference !== "cannot" &&
        a.vehicle_id !== null,
    );

    const confirmedForTrip = confirmedAssignmentsByTrip.get(trip.id) ?? [];
    const confirmedDriverIds = new Set(confirmedForTrip.map((a) => a.driver_profile_id));

    const candidateDrivers = eligibleAvailability
      .filter((a) => {
        // Skip drivers who declined or let expire this specific trip
        if (inputs.declinedTripsByDriver?.get(a.driver_profile_id)?.has(trip.id)) return false;
        if (inputs.expiredTripsByDriver?.get(a.driver_profile_id)?.has(trip.id)) return false;
        const maxDrives = inputs.maxDrivesByDriver.get(a.driver_profile_id) ?? 0;
        const already = assignmentsThisWeek.get(a.driver_profile_id) ?? 0;
        if (confirmedDriverIds.has(a.driver_profile_id)) return true;
        return already < maxDrives;
      })
      .sort((a, b) => {
        // Prefer drivers whose own children are among this trip's riders
        const aHousehold = householdByProfileId.get(a.driver_profile_id) ?? "";
        const bHousehold = householdByProfileId.get(b.driver_profile_id) ?? "";
        const aHasOwn = riders.some((r) => r.household_id === aHousehold);
        const bHasOwn = riders.some((r) => r.household_id === bHousehold);
        if (aHasOwn !== bHasOwn) return aHasOwn ? -1 : 1;

        const prefDiff = driverPreferenceRank(a.preference) -
          driverPreferenceRank(b.preference);
        if (prefDiff !== 0) return prefDiff;
        const aCount = assignmentsThisWeek.get(a.driver_profile_id) ?? 0;
        const bCount = assignmentsThisWeek.get(b.driver_profile_id) ?? 0;
        if (aCount !== bCount) return aCount - bCount;
        return a.driver_profile_id.localeCompare(b.driver_profile_id);
      });

    const remainingRiders = new Set(riders.map((r) => r.id));
    const tripAssignments: SchedulingDriverAssignment[] = [];

    const buildAssignment = (
      avail: SchedulingAvailability & { vehicle_id: string },
      confirmed: boolean,
    ): SchedulingDriverAssignment => {
      const vehicle = vehicleById.get(avail.vehicle_id);
      const capacity = vehicle?.child_passenger_capacity ?? 0;
      const driverHouseholdId = householdByProfileId.get(
        avail.driver_profile_id,
      ) ?? "";

      const assigned: string[] = [];
      const assignedSet = new Set<string>();
      const ownChildren = riders.filter(
        (r) =>
          r.household_id === driverHouseholdId &&
          remainingRiders.has(r.id),
      );
      for (const child of ownChildren) {
        if (assigned.length >= capacity) break;
        assigned.push(child.id);
        assignedSet.add(child.id);
        remainingRiders.delete(child.id);
      }
      // Pick best remaining other child each iteration.
      // Priority: child whose preferred buddy is already in the car,
      // then deterministic name/ID tiebreak.
      // Capacity check runs every iteration so we never overfill.
      const otherPool = riders
        .filter((r) => r.household_id !== driverHouseholdId)
        .sort((a, b) => childSortKey(a).localeCompare(childSortKey(b)));
      while (assigned.length < capacity && otherPool.length > 0) {
        let bestIdx = 0;
        for (let i = 1; i < otherPool.length; i++) {
          const candidate = otherPool[i];
          const best = otherPool[bestIdx];
          const candPriority = candidate.is_priority ?? false;
          const bestPriority = best.is_priority ?? false;
          if (candPriority !== bestPriority) {
            if (candPriority) bestIdx = i;
            continue;
          }
          const candBuddyInCar = candidate.preferred_buddy_child_id != null &&
            assignedSet.has(candidate.preferred_buddy_child_id);
          const bestBuddyInCar = best.preferred_buddy_child_id != null &&
            assignedSet.has(best.preferred_buddy_child_id);
          if (candBuddyInCar !== bestBuddyInCar) {
            if (candBuddyInCar) bestIdx = i;
            continue;
          }
          if (childSortKey(candidate).localeCompare(childSortKey(best)) < 0) {
            bestIdx = i;
          }
        }
        if (!remainingRiders.has(otherPool[bestIdx].id)) {
          otherPool.splice(bestIdx, 1);
          continue;
        }
        const chosen = otherPool.splice(bestIdx, 1)[0];
        assigned.push(chosen.id);
        assignedSet.add(chosen.id);
        remainingRiders.delete(chosen.id);
      }
      return {
        trip_id: trip.id,
        driver_profile_id: avail.driver_profile_id,
        vehicle_id: avail.vehicle_id,
        child_passenger_capacity: capacity,
        assigned_child_ids: assigned,
        confirmed,
      };
    };

    for (const confirmed of confirmedForTrip) {
      const avail = eligibleAvailability.find(
        (a) => a.driver_profile_id === confirmed.driver_profile_id,
      );
      if (!avail) {
        const vehicle = vehicleById.get(confirmed.vehicle_id);
        if (!vehicle) continue;
        tripAssignments.push({
          trip_id: trip.id,
          driver_profile_id: confirmed.driver_profile_id,
          vehicle_id: confirmed.vehicle_id,
          child_passenger_capacity: confirmed.child_passenger_capacity,
          assigned_child_ids: [],
          confirmed: true,
        });
        continue;
      }
      const assignment = buildAssignment(
        avail as SchedulingAvailability & { vehicle_id: string },
        true,
      );
      tripAssignments.push(assignment);
    }

    for (const avail of candidateDrivers) {
      if (remainingRiders.size === 0) break;
      if (confirmedDriverIds.has(avail.driver_profile_id)) continue;
      const assignment = buildAssignment(avail, false);
      if (assignment.assigned_child_ids.length > 0) {
        tripAssignments.push(assignment);
        assignmentsThisWeek.set(
          avail.driver_profile_id,
          (assignmentsThisWeek.get(avail.driver_profile_id) ?? 0) + 1,
        );
      }
    }

    const assignedRiderCount = riders.length - remainingRiders.size;
    const seatCount = tripAssignments.reduce(
      (sum, a) => sum + a.child_passenger_capacity,
      0,
    );
    tripResults.push({
      trip_id: trip.id,
      rider_count: riders.length,
      assigned_rider_count: assignedRiderCount,
      uncovered_rider_count: remainingRiders.size,
      driver_count: tripAssignments.length,
      seat_count: seatCount,
      assignments: tripAssignments,
      uncovered: remainingRiders.size > 0,
    });
  }

  return { trips: tripResults, algorithm_version: ALGORITHM_VERSION };
}