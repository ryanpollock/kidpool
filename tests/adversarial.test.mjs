// Phase 3: Adversarial algorithm tests for greedy-v1.
// Tests edge cases: empty weeks, everyone declines, zero capacity,
// 50-household scale, single-driver bottleneck, all-same-household,
// capacity-exactly-matches, re-generation determinism, confirmed vs tentative.
//
// Pure TS — runs under --experimental-strip-types, no DB needed.

import assert from "node:assert/strict";
import test from "node:test";

const greedyUrl = new URL(
  "../supabase/functions/_shared/scheduling/greedy-v1.ts",
  import.meta.url,
);

async function loadGreedyModule() {
  const module = await import(greedyUrl);
  return { generateSchedule: module.generateSchedule, ALGORITHM_VERSION: module.ALGORITHM_VERSION };
}

// ── Helpers ──────────────────────────────────────────────────────

function makeTrip(id, date, dir) {
  return { id, service_date: date, direction: dir };
}

function makeChild(id, hId, first, last) {
  return { id, household_id: hId, first_name: first, last_name: last };
}

function makeVehicle(id, hId, cap, label = "Car") {
  return { id, household_id: hId, label, child_passenger_capacity: cap };
}

function makeProfile(id, hId, name) {
  return { id, full_name: name, household_id: hId };
}

function makeRideRequest(tripId, childId, needs = true) {
  return { trip_id: tripId, child_id: childId, needs_ride: needs };
}

function makeAvail(tripId, driverId, vehicleId, pref = "can") {
  return { trip_id: tripId, driver_profile_id: driverId, vehicle_id: vehicleId, preference: pref };
}

function makeMaxDrives(map) {
  return new Map(Object.entries(map));
}

function totalAssigned(result) {
  return result.trips.reduce((sum, t) => sum + t.assigned_rider_count, 0);
}

function totalUncovered(result) {
  return result.trips.reduce((sum, t) => sum + t.uncovered_rider_count, 0);
}

// ── Tests ────────────────────────────────────────────────────────

test("Adversarial: empty week (no trips, no riders) returns empty result", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [],
    children: [],
    vehicles: [],
    profiles: [],
    rideRequests: [],
    availability: [],
    maxDrivesByDriver: new Map(),
    existingAssignments: [],
  });

  assert.equal(result.trips.length, 0);
  assert.equal(totalAssigned(result), 0);
  assert.equal(totalUncovered(result), 0);
  assert.equal(result.algorithm_version, "greedy-v1");
});

test("Adversarial: trips exist but no riders — zero assignments, zero uncovered", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [],
    vehicles: [],
    profiles: [],
    rideRequests: [],
    availability: [],
    maxDrivesByDriver: new Map(),
    existingAssignments: [],
  });

  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0].rider_count, 0);
  assert.equal(result.trips[0].assigned_rider_count, 0);
  assert.equal(result.trips[0].uncovered_rider_count, 0);
  assert.equal(result.trips[0].driver_count, 0);
  assert.equal(result.trips[0].assignments.length, 0);
  assert.equal(result.trips[0].uncovered, false);
});

test("Adversarial: riders exist but no drivers — all uncovered", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [makeChild("c1", "h1", "A", "Z")],
    vehicles: [],
    profiles: [],
    rideRequests: [makeRideRequest("t1", "c1")],
    availability: [],
    maxDrivesByDriver: new Map(),
    existingAssignments: [],
  });

  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0].rider_count, 1);
  assert.equal(result.trips[0].assigned_rider_count, 0);
  assert.equal(result.trips[0].uncovered_rider_count, 1);
  assert.equal(result.trips[0].uncovered, true);
});

test("Adversarial: driver available but zero capacity vehicle — no assignment", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [makeChild("c1", "h1", "A", "Z")],
    vehicles: [makeVehicle("v1", "h1", 0)],
    profiles: [makeProfile("p1", "h1", "Driver")],
    rideRequests: [makeRideRequest("t1", "c1")],
    availability: [makeAvail("t1", "p1", "v1", "prefer")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
  });

  assert.equal(result.trips[0].assigned_rider_count, 0);
  assert.equal(result.trips[0].uncovered_rider_count, 1);
  assert.equal(result.trips[0].driver_count, 0);
  assert.equal(result.trips[0].uncovered, true);
});

test("Adversarial: all drivers decline (preference=cannot) — all uncovered", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [makeChild("c1", "h1", "A", "Z"), makeChild("c2", "h2", "B", "Y")],
    vehicles: [makeVehicle("v1", "h1", 4), makeVehicle("v2", "h2", 4)],
    profiles: [makeProfile("p1", "h1", "D1"), makeProfile("p2", "h2", "D2")],
    rideRequests: [makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2")],
    availability: [makeAvail("t1", "p1", "v1", "cannot"), makeAvail("t1", "p2", "v2", "cannot")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
  });

  assert.equal(result.trips[0].assigned_rider_count, 0);
  assert.equal(result.trips[0].uncovered_rider_count, 2);
  assert.equal(result.trips[0].uncovered, true);
});

test("Adversarial: driver exceeds max_drives — not assigned", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const trips = [
    makeTrip("t1", "2026-08-03", "morning"),
    makeTrip("t2", "2026-08-04", "morning"),
    makeTrip("t3", "2026-08-05", "morning"),
  ];
  const result = generateSchedule({
    trips,
    children: [makeChild("c1", "h1", "A", "Z")],
    vehicles: [makeVehicle("v1", "h1", 4)],
    profiles: [makeProfile("p1", "h1", "Driver")],
    rideRequests: trips.map((t) => makeRideRequest(t.id, "c1")),
    availability: trips.map((t) => makeAvail(t.id, "p1", "v1", "prefer")),
    maxDrivesByDriver: makeMaxDrives({ p1: 2 }),
    existingAssignments: [],
  });

  // Driver can only drive 2 of 3 trips
  const assignedTrips = result.trips.filter((t) => t.assigned_rider_count > 0);
  assert.equal(assignedTrips.length, 2);
  assert.equal(totalUncovered(result), 1);
});

test("Adversarial: single driver bottleneck — own child prioritized", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [
      makeChild("c1", "h1", "Own", "Child"),
      makeChild("c2", "h2", "Other1", "Child"),
      makeChild("c3", "h3", "Other2", "Child"),
    ],
    vehicles: [makeVehicle("v1", "h1", 2)],
    profiles: [makeProfile("p1", "h1", "Driver")],
    rideRequests: [makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2"), makeRideRequest("t1", "c3")],
    availability: [makeAvail("t1", "p1", "v1", "prefer")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
  });

  // Capacity 2, 3 riders, own child gets priority
  assert.equal(result.trips[0].assigned_rider_count, 2);
  assert.equal(result.trips[0].uncovered_rider_count, 1);
  assert.equal(result.trips[0].uncovered, true);

  // Own child should be assigned
  const assignment = result.trips[0].assignments[0];
  assert.ok(assignment.assigned_child_ids.includes("c1"));
});

test("Adversarial: all children from same household — one driver covers all", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [
      makeChild("c1", "h1", "A", "Z"),
      makeChild("c2", "h1", "B", "Z"),
      makeChild("c3", "h1", "C", "Z"),
    ],
    vehicles: [makeVehicle("v1", "h1", 4)],
    profiles: [makeProfile("p1", "h1", "Driver")],
    rideRequests: [makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2"), makeRideRequest("t1", "c3")],
    availability: [makeAvail("t1", "p1", "v1", "prefer")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
  });

  assert.equal(result.trips[0].assigned_rider_count, 3);
  assert.equal(result.trips[0].uncovered_rider_count, 0);
  assert.equal(result.trips[0].driver_count, 1);
  assert.equal(result.trips[0].assignments[0].assigned_child_ids.length, 3);
});

test("Adversarial: capacity exactly matches riders — full coverage, no extras", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [
      makeChild("c1", "h1", "A", "Z"),
      makeChild("c2", "h2", "B", "Y"),
    ],
    vehicles: [makeVehicle("v1", "h1", 2)],
    profiles: [makeProfile("p1", "h1", "Driver")],
    rideRequests: [makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2")],
    availability: [makeAvail("t1", "p1", "v1", "prefer")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5 }),
    existingAssignments: [],
  });

  assert.equal(result.trips[0].assigned_rider_count, 2);
  assert.equal(result.trips[0].uncovered_rider_count, 0);
  assert.equal(result.trips[0].seat_count, 2);
  assert.equal(result.trips[0].uncovered, false);
});

test("Adversarial: re-generation produces identical result (determinism)", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = {
    trips: [makeTrip("t1", "2026-08-03", "morning"), makeTrip("t2", "2026-08-04", "morning")],
    children: [
      makeChild("c1", "h1", "A", "Z"),
      makeChild("c2", "h2", "B", "Y"),
      makeChild("c3", "h3", "C", "X"),
    ],
    vehicles: [makeVehicle("v1", "h1", 3), makeVehicle("v2", "h2", 2)],
    profiles: [makeProfile("p1", "h1", "D1"), makeProfile("p2", "h2", "D2")],
    rideRequests: [makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2"), makeRideRequest("t1", "c3"), makeRideRequest("t2", "c1")],
    availability: [makeAvail("t1", "p1", "v1", "prefer"), makeAvail("t1", "p2", "v2", "can"), makeAvail("t2", "p1", "v1", "can")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 3 }),
    existingAssignments: [],
  };

  const result1 = generateSchedule(inputs);
  const result2 = generateSchedule(inputs);
  assert.deepEqual(result1, result2);
});

test("Adversarial: 50-household scale — algorithm completes and covers all", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const trips = [makeTrip("t1", "2026-08-03", "morning")];
  const children = [];
  const vehicles = [];
  const profiles = [];
  const rideRequests = [];
  const availability = [];
  const maxDrives = {};

  for (let i = 0; i < 50; i++) {
    const hId = `h${i}`;
    const pId = `p${i}`;
    const vId = `v${i}`;
    const cId = `c${i}`;
    children.push(makeChild(cId, hId, `Child${i}`, "Last"));
    vehicles.push(makeVehicle(vId, hId, 4));
    profiles.push(makeProfile(pId, hId, `Driver${i}`));
    rideRequests.push(makeRideRequest("t1", cId));
    availability.push(makeAvail("t1", pId, vId, "prefer"));
    maxDrives[pId] = 5;
  }

  const result = generateSchedule({
    trips,
    children,
    vehicles,
    profiles,
    rideRequests,
    availability,
    maxDrivesByDriver: makeMaxDrives(maxDrives),
    existingAssignments: [],
  });

  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0].rider_count, 50);
  assert.equal(result.trips[0].assigned_rider_count, 50);
  assert.equal(result.trips[0].uncovered_rider_count, 0);
  assert.equal(result.trips[0].uncovered, false);
  // Each vehicle has capacity 4, so 50/4 = 13 drivers needed
  assert.equal(result.trips[0].driver_count, 13);
});

test("Adversarial: confirmed assignments count toward max_drives enforcement", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Driver has 2 confirmed assignments already, max_drives = 2
  // So they should NOT be assigned any more trips
  const trips = [
    makeTrip("t1", "2026-08-03", "morning"),
    makeTrip("t2", "2026-08-04", "morning"),
    makeTrip("t3", "2026-08-05", "morning"),
  ];
  const result = generateSchedule({
    trips,
    children: [makeChild("c1", "h1", "A", "Z")],
    vehicles: [makeVehicle("v1", "h1", 4)],
    profiles: [makeProfile("p1", "h1", "Driver")],
    rideRequests: trips.map((t) => makeRideRequest(t.id, "c1")),
    availability: trips.map((t) => makeAvail(t.id, "p1", "v1", "prefer")),
    maxDrivesByDriver: makeMaxDrives({ p1: 2 }),
    existingAssignments: [
      { driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 4, confirmed: true },
      { driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 4, confirmed: true },
    ],
  });

  // Driver already has 2 confirmed, max is 2 — no new assignments
  const assignedTrips = result.trips.filter((t) => t.assigned_rider_count > 0);
  assert.equal(assignedTrips.length, 0);
  assert.equal(totalUncovered(result), 3);
});

test("Adversarial: fairness — least-loaded driver gets priority", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const trips = [
    makeTrip("t1", "2026-08-03", "morning"),
    makeTrip("t2", "2026-08-04", "morning"),
  ];
  const result = generateSchedule({
    trips,
    children: [makeChild("c1", "h3", "Child", "X")],
    vehicles: [makeVehicle("v1", "h1", 4), makeVehicle("v2", "h2", 4)],
    profiles: [makeProfile("p1", "h1", "D1"), makeProfile("p2", "h2", "D2")],
    rideRequests: [makeRideRequest("t1", "c1"), makeRideRequest("t2", "c1")],
    availability: [
      makeAvail("t1", "p1", "v1", "can"),
      makeAvail("t1", "p2", "v2", "can"),
      makeAvail("t2", "p1", "v1", "can"),
      makeAvail("t2", "p2", "v2", "can"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
  });

  // Both trips have the same rider, two equally-preferenced drivers
  // After trip 1: one driver gets +1. Trip 2 should assign the other driver.
  const trip1Driver = result.trips[0].assignments[0]?.driver_profile_id;
  const trip2Driver = result.trips[1].assignments[0]?.driver_profile_id;
  assert.ok(trip1Driver);
  assert.ok(trip2Driver);
  assert.notEqual(trip1Driver, trip2Driver, "Different drivers should be chosen for fairness");
});