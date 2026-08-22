// Algorithm tests for the second-afternoon-trip feature (pm_early + pm_late).
// Tests the "either/or" scheduling logic, slot-based sort order, and backward
// compatibility. Pure TS — runs under --experimental-strip-types, no DB needed.

import assert from "node:assert/strict";
import test from "node:test";

const greedyUrl = new URL(
  "../supabase/functions/_shared/scheduling/balanced-greedy-v2.ts",
  import.meta.url,
);

async function loadGreedyModule() {
  const module = await import(greedyUrl);
  return { generateSchedule: module.generateSchedule };
}

// ── Helpers ──────────────────────────────────────────────────────

function makeTrip(id, date, slot) {
  const direction = slot === "am" ? "morning" : "afternoon";
  return { id, service_date: date, direction, slot };
}

function makeChild(id, hId, first, last = "Test") {
  return { id, household_id: hId, first_name: first, last_name: last };
}

function makeVehicle(id, hId, cap, label = "Car") {
  return { id, household_id: hId, label, child_passenger_capacity: cap };
}

function makeProfile(id, hId, name = "Parent") {
  return { id, full_name: name, household_id: hId };
}

function makeRideRequest(tripId, childId, preference = "specific", needs = true) {
  return { trip_id: tripId, child_id: childId, needs_ride: needs, preference };
}

function makeAvail(tripId, driverId, vehicleId, pref = "can") {
  return { trip_id: tripId, driver_profile_id: driverId, vehicle_id: vehicleId, preference: pref };
}

function makeMaxDrives(map) {
  return new Map(Object.entries(map));
}

function findTripResult(outputs, tripId) {
  return outputs.trips.find((t) => t.trip_id === tripId);
}

// ── Tests ────────────────────────────────────────────────────────

test("A1: sort order — am processes before pm_early, pm_early before pm_late", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // Put a driver on pm_late only. If pm_late processed before pm_early,
  // the "either" rider would be assigned to pm_late (it's the only trip
  // with a driver). But since pm_early processes first, the "either"
  // rider has no driver on pm_early and remains uncovered there.
  // Then on pm_late they get assigned. So pm_late should have 1 assigned
  // and pm_early should have 1 uncovered.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_am", date, "am"),
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t_am", "c1", "specific"),
      makeRideRequest("t_early", "c1", "either"),
      makeRideRequest("t_late", "c1", "either"),
    ],
    availability: [
      makeAvail("t_am", "p1", "v1", "prefer"),
      makeAvail("t_late", "p1", "v1", "can"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const amResult = findTripResult(outputs, "t_am");
  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(amResult?.assigned_rider_count, 1, "Alice assigned to morning");
  assert.equal(earlyResult?.uncovered_rider_count, 1, "pm_early uncovered — no driver");
  assert.equal(lateResult?.assigned_rider_count, 1, "Alice assigned to pm_late (fallback)");
  assert.equal(lateResult?.rider_count, 1, "pm_late rider count = 1 (either rider not filtered since pm_early had no assignment)");
});

test("A2: either rider assigned to pm_early, skipped on pm_late", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t_early", "c1", "either"),
      makeRideRequest("t_late", "c1", "either"),
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.assigned_rider_count, 1, "Alice assigned to pm_early");
  assert.equal(lateResult?.rider_count, 0, "pm_late rider count = 0 (either rider filtered out)");
  assert.equal(lateResult?.uncovered_rider_count, 0, "pm_late has no uncovered riders");
});

test("A3: either rider doesn't fit on pm_early, falls back to pm_late", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // pm_early has no driver, so the either rider can't get a seat there.
  // They should appear on pm_late and get assigned.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t_early", "c1", "either"),
      makeRideRequest("t_late", "c1", "either"),
    ],
    availability: [
      makeAvail("t_late", "p1", "v1", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.uncovered_rider_count, 1, "pm_early uncovered — no driver");
  assert.equal(lateResult?.assigned_rider_count, 1, "Alice assigned to pm_late (fallback)");
  assert.equal(lateResult?.rider_count, 1, "pm_late rider count = 1");
});

test("A4: either rider doesn't fit on either trip", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // No drivers on either afternoon trip.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t_early", "c1", "either"),
      makeRideRequest("t_late", "c1", "either"),
    ],
    availability: [],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.uncovered_rider_count, 1, "pm_early uncovered");
  assert.equal(lateResult?.uncovered_rider_count, 1, "pm_late also uncovered");
  // Total uncovered across both trips = 2 (the rider appears on both trip results
  // since they couldn't be assigned to either). This is by design — the coordinator
  // sees the rider uncovered on both trips and can resolve manually.
});

test("A5: specific rider on pm_early doesn't appear on pm_late", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t_early", "c1", "specific"),
      // No ride request on t_late
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.assigned_rider_count, 1, "Alice assigned to pm_early");
  assert.equal(lateResult?.rider_count, 0, "pm_late has no riders");
});

test("A6: specific rider on pm_late doesn't appear on pm_early", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      // No ride request on t_early
      makeRideRequest("t_late", "c1", "specific"),
    ],
    availability: [
      makeAvail("t_late", "p1", "v1", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.rider_count, 0, "pm_early has no riders");
  assert.equal(lateResult?.assigned_rider_count, 1, "Alice assigned to pm_late");
});

test("A7: mixed — some specific-early, some specific-late, some either", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // 3 children: Bob wants pm_early only, Carol wants pm_late only, Alice wants either.
  // Drivers: p1 (h1, Alice's parent) on pm_early, p2 (h2, Bob+Carol's parent) on pm_late.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [
      makeChild("c1", "h1", "Alice"),
      makeChild("c2", "h2", "Bob"),
      makeChild("c3", "h2", "Carol"),
    ],
    vehicles: [
      makeVehicle("v1", "h1", 3),
      makeVehicle("v2", "h2", 3),
    ],
    profiles: [
      makeProfile("p1", "h1"),
      makeProfile("p2", "h2"),
    ],
    rideRequests: [
      makeRideRequest("t_early", "c1", "either"), // Alice: either
      makeRideRequest("t_late", "c1", "either"),
      makeRideRequest("t_early", "c2", "specific"), // Bob: pm_early only
      makeRideRequest("t_late", "c3", "specific"), // Carol: pm_late only
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
      makeAvail("t_late", "p2", "v2", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  // pm_early: Alice (either) + Bob (specific) = 2 riders, both assigned
  assert.equal(earlyResult?.rider_count, 2, "pm_early has Alice + Bob");
  assert.equal(earlyResult?.assigned_rider_count, 2, "both assigned on pm_early");

  // pm_late: Carol (specific) only — Alice was filtered out (assigned to pm_early)
  assert.equal(lateResult?.rider_count, 1, "pm_late has Carol only (Alice filtered)");
  assert.equal(lateResult?.assigned_rider_count, 1, "Carol assigned on pm_late");
});

test("A8: load balancing — driver on both pm trips counts as 2 drives", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // Same driver, max_drives = 2. They drive pm_early and pm_late.
  // No morning trip so both drives go to afternoon trips.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [
      makeChild("c1", "h1", "Alice"),
      makeChild("c2", "h1", "Bob"),
    ],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t_early", "c1", "specific"),
      makeRideRequest("t_late", "c2", "specific"),
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
      makeAvail("t_late", "p1", "v1", "can"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 2 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.driver_count, 1, "p1 drives pm_early (1st drive)");
  assert.equal(lateResult?.driver_count, 1, "p1 drives pm_late (2nd drive)");
  assert.equal(earlyResult?.assigned_rider_count, 1, "Alice assigned on pm_early");
  assert.equal(lateResult?.assigned_rider_count, 1, "Bob assigned on pm_late");
});

test("A9: shared-car rule — same household can drive both pm trips", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // Two drivers from same household, each on a different pm trip.
  // Shared-car rule is per-trip, so this should work.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [
      makeChild("c1", "h1", "Alice"),
      makeChild("c2", "h1", "Bob"),
    ],
    vehicles: [
      makeVehicle("v1", "h1", 3),
      makeVehicle("v2", "h1", 3),
    ],
    profiles: [
      makeProfile("p1", "h1"),
      makeProfile("p2", "h1"),
    ],
    rideRequests: [
      makeRideRequest("t_early", "c1", "specific"),
      makeRideRequest("t_late", "c2", "specific"),
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
      makeAvail("t_late", "p2", "v2", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.driver_count, 1, "p1 drives pm_early");
  assert.equal(lateResult?.driver_count, 1, "p2 drives pm_late (same household, different trip)");
  assert.equal(earlyResult?.assigned_rider_count, 1, "Alice assigned");
  assert.equal(lateResult?.assigned_rider_count, 1, "Bob assigned");
});

test("A10: backward compat — trips without slot still work", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // Trips with no slot field (undefined) — simulates old data.
  // The scheduler should fall back to slot order "2" (pm_late) for afternoon.
  const outputs = generateSchedule({
    trips: [
      { id: "t1", service_date: date, direction: "morning", slot: undefined },
      { id: "t2", service_date: date, direction: "afternoon", slot: undefined },
    ],
    children: [makeChild("c1", "h1", "Alice")],
    vehicles: [makeVehicle("v1", "h1", 3)],
    profiles: [makeProfile("p1", "h1")],
    rideRequests: [
      makeRideRequest("t1", "c1", "specific"),
      makeRideRequest("t2", "c1", "specific"),
    ],
    availability: [
      makeAvail("t1", "p1", "v1", "prefer"),
      makeAvail("t2", "p1", "v1", "can"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const t1Result = findTripResult(outputs, "t1");
  const t2Result = findTripResult(outputs, "t2");

  assert.equal(t1Result?.assigned_rider_count, 1, "Alice assigned to morning");
  assert.equal(t2Result?.assigned_rider_count, 1, "Alice assigned to afternoon");
  // No crash, no either/or filtering (both are "specific")
});

test("A11: determinism — same inputs produce identical outputs", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  const inputs = {
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [
      makeChild("c1", "h1", "Alice"),
      makeChild("c2", "h2", "Bob"),
    ],
    vehicles: [
      makeVehicle("v1", "h1", 3),
      makeVehicle("v2", "h2", 2),
    ],
    profiles: [
      makeProfile("p1", "h1"),
      makeProfile("p2", "h2"),
    ],
    rideRequests: [
      makeRideRequest("t_early", "c1", "either"),
      makeRideRequest("t_late", "c1", "either"),
      makeRideRequest("t_early", "c2", "specific"),
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
      makeAvail("t_early", "p2", "v2", "can"),
      makeAvail("t_late", "p2", "v2", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };

  const outputs1 = generateSchedule(inputs);
  const outputs2 = generateSchedule(inputs);

  assert.deepEqual(outputs1, outputs2, "identical outputs on re-run");
});

test("A12: either rider with buddy on pm_early — both skipped on pm_late", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const date = "2026-08-03";
  // Alice (either) and Bob (either) are buddies. Both fit on pm_early.
  // Both should be filtered from pm_late.
  const outputs = generateSchedule({
    trips: [
      makeTrip("t_early", date, "pm_early"),
      makeTrip("t_late", date, "pm_late"),
    ],
    children: [
      { ...makeChild("c1", "h1", "Alice"), preferred_buddy_child_id: "c2" },
      { ...makeChild("c2", "h2", "Bob"), preferred_buddy_child_id: "c1" },
    ],
    vehicles: [
      makeVehicle("v1", "h1", 3),
      makeVehicle("v2", "h2", 3),
    ],
    profiles: [
      makeProfile("p1", "h1"),
      makeProfile("p2", "h2"),
    ],
    rideRequests: [
      makeRideRequest("t_early", "c1", "either"),
      makeRideRequest("t_late", "c1", "either"),
      makeRideRequest("t_early", "c2", "either"),
      makeRideRequest("t_late", "c2", "either"),
    ],
    availability: [
      makeAvail("t_early", "p1", "v1", "prefer"),
      makeAvail("t_early", "p2", "v2", "can"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  const earlyResult = findTripResult(outputs, "t_early");
  const lateResult = findTripResult(outputs, "t_late");

  assert.equal(earlyResult?.assigned_rider_count, 2, "both assigned to pm_early");
  assert.equal(lateResult?.rider_count, 0, "pm_late has 0 riders (both filtered)");
  assert.equal(lateResult?.uncovered_rider_count, 0, "pm_late has no uncovered");
});