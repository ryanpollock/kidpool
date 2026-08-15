// Balanced greedy scheduler, version 2.
// Zero imports so it runs in both Deno (Edge Function) and Node (tests).
// To swap in a better algorithm later, add a new module and select by version.
//
// v2 adds a hard constraint over v1:
//   0. Shared-car rule — at most one driver per household per trip. A
//      household often has multiple adults who can drive but only one car;
//      selecting two drivers from the same household for the same trip
//      assumes a second vehicle that does not exist. This is enforced
//      strictly: if skipping a same-household candidate leaves the trip
//      short on seats, those riders are reported as uncovered rather than
//      relaxing the rule. The coordinator triage board resolves them.
//
// Design objectives (in priority order, after the hard constraint above):
//   1. Coverage — seat every child who needs a ride.
//   2. Load balance — spread driving across parents over the week.
//   3. Own kids with their parent — selected drivers' own children ride
//      in their car (seats reserved before anyone else's).
//   4. Minimize drivers — given the above, use the fewest drivers.
//   5. Priority children, riding buddies, driver preference, determinism.
//
// Two-phase approach:
//   Phase 1 — select the minimum drivers (sorted by least-loaded first),
//             skipping any candidate whose household is already driving
//   Phase 2 — fill cars (own kids first, then others with reservation)

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

export const ALGORITHM_VERSION = "balanced-greedy-v2";

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

  // Confirmed-assignment lookup (for confirmed/tentative output marking).
  const confirmedKeys = new Set<string>();
  for (const assignment of inputs.existingAssignments) {
    if (assignment.confirmed) {
      confirmedKeys.add(`${assignment.trip_id}|${assignment.driver_profile_id}`);
    }
  }

// Running weekly drive count — the load-balance counter.
// Starts at 0 for everyone. The algorithm re-optimizes from scratch;
// prior-version assignments don't count toward this week's load.
const assignmentsThisWeek = new Map<string, number>();

  const tripResults: SchedulingTripResult[] = [];

  for (const trip of sortedTrips) {
    const riders = inputs.rideRequests
      .filter((r) => r.trip_id === trip.id && r.needs_ride)
      .map((r) => childById.get(r.child_id))
      .filter((c): c is SchedulingChild => c !== undefined)
      // ↑ Drops ride requests for deactivated children (childById only contains
      // active=true children). See deactivateChild in carpool-repository.ts
      // for the known data-hygiene gap — stale rows stay in the DB.
      .sort((a, b) => childSortKey(a).localeCompare(childSortKey(b)));

    const riderHouseholds = new Set(riders.map((r) => r.household_id));

    const eligibleAvailability = inputs.availability.filter(
      (a): a is SchedulingAvailability & { vehicle_id: string } =>
        a.trip_id === trip.id &&
        a.preference !== "cannot" &&
        a.vehicle_id !== null,
    );

    // ── Phase 1: Select drivers ────────────────────────────────
    // Eligibility: natural drivers only (own kids need a ride on this trip),
    // not declined/expired, under max_drives.
    const candidateDrivers = eligibleAvailability
      .filter((a) => {
        if (inputs.declinedTripsByDriver?.get(a.driver_profile_id)?.has(trip.id)) return false;
        if (inputs.expiredTripsByDriver?.get(a.driver_profile_id)?.has(trip.id)) return false;
        const maxDrives = inputs.maxDrivesByDriver.get(a.driver_profile_id) ?? 0;
        const already = assignmentsThisWeek.get(a.driver_profile_id) ?? 0;
        if (already >= maxDrives) return false;
        const household = householdByProfileId.get(a.driver_profile_id) ?? "";
        if (!riderHouseholds.has(household)) return false;
        return true;
      })
      .sort((a, b) => {
        // Primary: least-loaded this week (load balance).
        const aCount = assignmentsThisWeek.get(a.driver_profile_id) ?? 0;
        const bCount = assignmentsThisWeek.get(b.driver_profile_id) ?? 0;
        if (aCount !== bCount) return aCount - bCount;
        // Secondary: preference (prefer > can).
        const prefDiff = driverPreferenceRank(a.preference) -
          driverPreferenceRank(b.preference);
        if (prefDiff !== 0) return prefDiff;
        // Final: profile ID for determinism.
        return a.driver_profile_id.localeCompare(b.driver_profile_id);
      });

    // Greedily select until total raw capacity >= riders count.
    // Shared-car rule: at most one driver per household per trip. A
    // candidate whose household is already selected is skipped, even if
    // that leaves accumulatedCapacity short of the rider count. Uncovered
    // riders are reported via the trip result for coordinator resolution.
    const selectedDrivers: (SchedulingAvailability & { vehicle_id: string })[] = [];
    const selectedHouseholds = new Set<string>();
    let accumulatedCapacity = 0;
    for (const avail of candidateDrivers) {
      if (accumulatedCapacity >= riders.length) break;
      const household = householdByProfileId.get(avail.driver_profile_id) ?? "";
      if (selectedHouseholds.has(household)) continue;
      const vehicle = vehicleById.get(avail.vehicle_id);
      accumulatedCapacity += vehicle?.child_passenger_capacity ?? 0;
      selectedDrivers.push(avail);
      selectedHouseholds.add(household);
    }

    // Reserved households: all selected drivers' households. Their children
    // are blocked from other drivers' cars until their parent is processed.
    const reservedDriverHouseholds = new Set<string>();
    for (const avail of selectedDrivers) {
      reservedDriverHouseholds.add(
        householdByProfileId.get(avail.driver_profile_id) ?? "",
      );
    }
    const processedDriverHouseholds = new Set<string>();

    const remainingRiders = new Set(riders.map((r) => r.id));
    const tripAssignments: SchedulingDriverAssignment[] = [];

    // ── Phase 2: Fill cars ────────────────────────────────────
    const buildAssignment = (
      avail: SchedulingAvailability & { vehicle_id: string },
    ): SchedulingDriverAssignment => {
      const vehicle = vehicleById.get(avail.vehicle_id);
      const capacity = vehicle?.child_passenger_capacity ?? 0;
      const driverHouseholdId = householdByProfileId.get(
        avail.driver_profile_id,
      ) ?? "";

      const assigned: string[] = [];
      const assignedSet = new Set<string>();

      // Own children first (up to capacity).
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

      // Mark this household as processed so overflow kids (car was full)
      // become available to subsequent drivers.
      processedDriverHouseholds.add(driverHouseholdId);

      // Fill remaining seats with other riders.
      // Exclude children from reserved households that haven't been
      // processed yet — they're reserved for their own parent's car.
      const otherPool = riders
        .filter((r) => r.household_id !== driverHouseholdId)
        .filter((r) =>
          !reservedDriverHouseholds.has(r.household_id) ||
          processedDriverHouseholds.has(r.household_id)
        )
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

      const confirmed = confirmedKeys.has(
        `${trip.id}|${avail.driver_profile_id}`,
      );

      return {
        trip_id: trip.id,
        driver_profile_id: avail.driver_profile_id,
        vehicle_id: avail.vehicle_id,
        child_passenger_capacity: capacity,
        assigned_child_ids: assigned,
        confirmed,
      };
    };

    for (const avail of selectedDrivers) {
      const assignment = buildAssignment(avail);
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