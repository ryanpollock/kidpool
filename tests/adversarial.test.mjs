// Phase 3: Adversarial algorithm tests for balanced-greedy-v2.
// Tests edge cases: empty weeks, everyone declines, zero capacity,
// 50-household scale, single-driver bottleneck, all-same-household,
// capacity-exactly-matches, re-generation determinism, confirmed vs tentative,
// shared-car rule (no two same-household drivers on one trip).
//
// Pure TS — runs under --experimental-strip-types, no DB needed.

import assert from "node:assert/strict";
import test from "node:test";

const greedyUrl = new URL(
  "../supabase/functions/_shared/scheduling/balanced-greedy-v2.ts",
  import.meta.url,
);

async function loadGreedyModule() {
  const module = await import(greedyUrl);
  return { generateSchedule: module.generateSchedule, ALGORITHM_VERSION: module.ALGORITHM_VERSION };
}

// ── Helpers ──────────────────────────────────────────────────────

function makeTrip(id, date, dir, slot) {
  if (slot === undefined) {
    slot = dir === "morning" ? "am" : "pm_late";
  }
  return { id, service_date: date, direction: dir, slot };
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

function makeRideRequest(tripId, childId, needs = true, preference = "specific") {
  return { trip_id: tripId, child_id: childId, needs_ride: needs, preference };
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  assert.equal(result.trips.length, 0);
  assert.equal(totalAssigned(result), 0);
  assert.equal(totalUncovered(result), 0);
  assert.equal(result.algorithm_version, "balanced-greedy-v2");
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
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
      { trip_id: "t1", driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 4, confirmed: true },
      { trip_id: "t2", driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 4, confirmed: true },
    ],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  // Driver already has 2 confirmed, max is 2 — confirmed trips preserved, 3rd uncovered
  const assignedTrips = result.trips.filter((t) => t.assigned_rider_count > 0);
  assert.equal(assignedTrips.length, 2);
  assert.equal(totalUncovered(result), 1);
});

test("Adversarial: fairness — least-loaded driver gets priority", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const trips = [
    makeTrip("t1", "2026-08-03", "morning"),
    makeTrip("t2", "2026-08-04", "morning"),
  ];
  const result = generateSchedule({
    trips,
    children: [makeChild("c1", "h1", "Child", "A"), makeChild("c2", "h2", "Child", "B")],
    vehicles: [makeVehicle("v1", "h1", 4), makeVehicle("v2", "h2", 4)],
    profiles: [makeProfile("p1", "h1", "D1"), makeProfile("p2", "h2", "D2")],
    rideRequests: [
      makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2"),
      makeRideRequest("t2", "c1"), makeRideRequest("t2", "c2"),
    ],
    availability: [
      makeAvail("t1", "p1", "v1", "can"),
      makeAvail("t1", "p2", "v2", "can"),
      makeAvail("t2", "p1", "v1", "can"),
      makeAvail("t2", "p2", "v2", "can"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });

  // Both trips have 2 riders from h1 and h2, two equally-preferenced drivers.
  // t1: p1 wins by name sort (both at 0). t2: p2 wins (0 vs p1's 1) — load balanced.
  const trip1Driver = result.trips[0].assignments[0]?.driver_profile_id;
  const trip2Driver = result.trips[1].assignments[0]?.driver_profile_id;
  assert.ok(trip1Driver);
  assert.ok(trip2Driver);
  assert.notEqual(trip1Driver, trip2Driver, "Different drivers should be chosen for fairness");
});

// ── balanced-greedy-v2 specific tests ─────────────────────────────

test("balanced-greedy: non-natural driver (kids don't need ride) is never selected", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // p1 has a car and availability, but p1's child c1 does NOT need a ride.
  // p2's child c2 does need a ride. Only p2 should be selected.
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [makeChild("c1", "h1", "A", "Z"), makeChild("c2", "h2", "B", "Z")],
    vehicles: [makeVehicle("v1", "h1", 4), makeVehicle("v2", "h2", 4)],
    profiles: [makeProfile("p1", "h1", "D1"), makeProfile("p2", "h2", "D2")],
    rideRequests: [makeRideRequest("t1", "c2")], // only c2 needs a ride
    availability: [makeAvail("t1", "p1", "v1", "prefer"), makeAvail("t1", "p2", "v2", "can")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  const t1 = result.trips[0];
  const p1Assign = t1.assignments.find((a) => a.driver_profile_id === "p1");
  const p2Assign = t1.assignments.find((a) => a.driver_profile_id === "p2");
  assert.equal(p1Assign, undefined, "p1 should NOT be selected (no own child needs ride)");
  assert.ok(p2Assign, "p2 should be selected (own child c2 needs ride)");
  assert.ok(p2Assign.assigned_child_ids.includes("c2"), "p2's own child c2 should be in car");
});

test("balanced-greedy: own children in their car, not another driver's", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Two driver households, each with 2 children. Both drivers available.
  // Without reservation: the first-processed driver fills their car with
  // the other household's children, leaving the second driver's own
  // children in the wrong car.
  const trips = [makeTrip("t1", "2026-08-03", "morning")];
  const children = [
    makeChild("c1", "h1", "Finn", "OBrien"),
    makeChild("c2", "h1", "Maeve", "OBrien"),
    makeChild("c3", "h2", "W1", "Williams"),
    makeChild("c4", "h2", "W2", "Williams"),
    makeChild("c5", "h2", "W3", "Williams"),
  ];
  const vehicles = [makeVehicle("v1", "h1", 3), makeVehicle("v2", "h2", 4)];
  const profiles = [makeProfile("p1", "h1", "Sean OBrien"), makeProfile("p2", "h2", "Williams Parent")];
  const result = generateSchedule({
    trips,
    children,
    vehicles,
    profiles,
    rideRequests: children.map((c) => makeRideRequest("t1", c.id)),
    availability: [makeAvail("t1", "p1", "v1", "prefer"), makeAvail("t1", "p2", "v2", "prefer")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  const trip = result.trips[0];
  assert.equal(trip.driver_count, 2, "Both drivers should be used");
  const seanAssignment = trip.assignments.find((a) => a.driver_profile_id === "p1");
  const williamsAssignment = trip.assignments.find((a) => a.driver_profile_id === "p2");
  assert.ok(seanAssignment && seanAssignment.assigned_child_ids.includes("c1"), "Sean's child c1 must be in Sean's car");
  assert.ok(seanAssignment && seanAssignment.assigned_child_ids.includes("c2"), "Sean's child c2 must be in Sean's car");
  assert.ok(williamsAssignment && williamsAssignment.assigned_child_ids.includes("c3"), "Williams' child c3 must be in Williams' car");
  assert.ok(williamsAssignment && williamsAssignment.assigned_child_ids.includes("c4"), "Williams' child c4 must be in Williams' car");
  assert.ok(williamsAssignment && williamsAssignment.assigned_child_ids.includes("c5"), "Williams' child c5 must be in Williams' car");
  assert.equal(trip.uncovered_rider_count, 0, "No children should be uncovered");
});

test("balanced-greedy: confirmed driver can be dropped in re-optimization", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // p1 was confirmed on t1, but p2 is less-loaded and also a natural driver.
  // The algorithm should re-optimize: p2 drives t1 instead of p1.
  const result = generateSchedule({
    trips: [
      makeTrip("t1", "2026-08-03", "morning"),
      makeTrip("t2", "2026-08-04", "morning"),
    ],
    children: [makeChild("c1", "h1", "A", "Z"), makeChild("c2", "h2", "B", "Z")],
    vehicles: [makeVehicle("v1", "h1", 4), makeVehicle("v2", "h2", 4)],
    profiles: [makeProfile("p1", "h1", "D1"), makeProfile("p2", "h2", "D2")],
    rideRequests: [
      makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2"),
      makeRideRequest("t2", "c1"), makeRideRequest("t2", "c2"),
    ],
    availability: [
      makeAvail("t1", "p1", "v1", "prefer"), makeAvail("t1", "p2", "v2", "prefer"),
      makeAvail("t2", "p1", "v1", "prefer"), makeAvail("t2", "p2", "v2", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [
      { trip_id: "t1", driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 4, confirmed: true },
      { trip_id: "t2", driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 4, confirmed: true },
    ],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  // p1 was confirmed on both trips but re-optimization should load-balance:
  // t1: p1 (0-loaded, name sort). t2: p2 (0-loaded vs p1's 1).
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const t2 = result.trips.find((t) => t.trip_id === "t2");
  const p1OnT1 = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  const p2OnT2 = t2?.assignments.find((a) => a.driver_profile_id === "p2");
  assert.ok(p1OnT1, "p1 should drive t1");
  assert.ok(p2OnT2, "p2 should drive t2 (re-optimized for load balance)");
  assert.equal(p1OnT1.confirmed, true, "p1 on t1 stays confirmed");
  assert.equal(p2OnT2.confirmed, false, "p2 on t2 is tentative (newly selected)");
});

test("balanced-greedy: overflow kid placed after parent's car is full", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Lisa (h1) has 4 kids, 3-seat car. Another driver p2 (h2, 4 seats) available.
  // Lisa drives with 3 of her 4 kids. The 4th goes to p2's car.
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [
      makeChild("c1", "h1", "A", "X"), makeChild("c2", "h1", "B", "X"),
      makeChild("c3", "h1", "C", "X"), makeChild("c4", "h1", "D", "X"),
      makeChild("c5", "h2", "E", "Y"),
    ],
    vehicles: [makeVehicle("v1", "h1", 3), makeVehicle("v2", "h2", 4)],
    profiles: [makeProfile("p1", "h1", "Lisa"), makeProfile("p2", "h2", "Other")],
    rideRequests: [
      makeRideRequest("t1", "c1"), makeRideRequest("t1", "c2"),
      makeRideRequest("t1", "c3"), makeRideRequest("t1", "c4"),
      makeRideRequest("t1", "c5"),
    ],
    availability: [makeAvail("t1", "p1", "v1", "prefer"), makeAvail("t1", "p2", "v2", "can")],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  const t1 = result.trips[0];
  const lisa = t1.assignments.find((a) => a.driver_profile_id === "p1");
  const other = t1.assignments.find((a) => a.driver_profile_id === "p2");
  assert.ok(lisa, "Lisa should drive");
  assert.equal(lisa.assigned_child_ids.length, 3, "Lisa's car is full (3 of 4 kids)");
  assert.ok(other, "Other driver should cover overflow");
  assert.equal(other.assigned_child_ids.length, 2, "Other driver has overflow kid + own child");
  assert.equal(t1.uncovered_rider_count, 0, "All 5 riders covered");
});

// ── Shared-car rule (balanced-greedy-v2) ─────────────────────────────
// At most one driver per household per trip. A household often has multiple
// adults who can drive but only one car. The rule is enforced strictly:
// if the second same-household driver is the ONLY path to full coverage,
// the algorithm leaves riders uncovered rather than relaxing the rule.

test("shared-car: second co-parent is the only path to coverage — strictly enforced, riders uncovered", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // h1 has 2 co-parents (p1, p2) each with a 2-seat vehicle, and 3 children
  // riding. No other household has a driver available on this trip. Without
  // the shared-car rule: p1 (cap 2) + p2 (cap 2) = 4 >= 3 → both selected,
  // all 3 covered. With the rule: p1 selected, p2 skipped (same household),
  // 1 rider uncovered.
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [
      makeChild("c1", "h1", "Ava", "Adams"),
      makeChild("c2", "h1", "Ben", "Adams"),
      makeChild("c3", "h1", "Cleo", "Adams"),
    ],
    vehicles: [
      makeVehicle("v1", "h1", 2, "Adams car 1"),
      makeVehicle("v2", "h1", 2, "Adams car 2"),
    ],
    profiles: [
      makeProfile("p1", "h1", "Adams Parent A"),
      makeProfile("p2", "h1", "Adams Parent B"),
    ],
    rideRequests: [
      makeRideRequest("t1", "c1"),
      makeRideRequest("t1", "c2"),
      makeRideRequest("t1", "c3"),
    ],
    availability: [
      makeAvail("t1", "p1", "v1", "prefer"),
      makeAvail("t1", "p2", "v2", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  const t1 = result.trips[0];
  assert.equal(t1.driver_count, 1, "only one co-parent should drive (shared-car rule)");
  assert.equal(t1.assigned_rider_count, 2, "only 2 of 3 riders fit in the one car");
  assert.equal(t1.uncovered_rider_count, 1, "1 rider strictly uncovered rather than reusing the household's second driver");
  assert.equal(t1.uncovered, true);
  assert.ok(t1.assignments.find((a) => a.driver_profile_id === "p1"), "p1 selected (name-sort tiebreak)");
  assert.equal(t1.assignments.find((a) => a.driver_profile_id === "p2"), undefined, "p2 must NOT be selected — same household as p1");
});

test("shared-car: two co-parents both available but second household also has a driver — second co-parent skipped, coverage maintained", async () => {
  // h1: 2 co-parents (p1, p2), 3 children, two 2-seat cars. h2: 1 driver (p3),
  // 1 child, 2-seat car. All 4 riding. p1 selected (h1, cap 2). p2 SKIPPED
  // (h1 already driving). p3 selected (h2, cap 2). Total cap 4 >= 4 → all
  // covered. The rule fired (p2 skipped) but coverage was preserved by p3.
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [makeTrip("t1", "2026-08-03", "morning")],
    children: [
      makeChild("c1", "h1", "Ava", "Adams"),
      makeChild("c2", "h1", "Ben", "Adams"),
      makeChild("c3", "h1", "Cleo", "Adams"),
      makeChild("c4", "h2", "Dan", "Bennett"),
    ],
    vehicles: [
      makeVehicle("v1", "h1", 2, "Adams car 1"),
      makeVehicle("v2", "h1", 2, "Adams car 2"),
      makeVehicle("v3", "h2", 2, "Bennett car"),
    ],
    profiles: [
      makeProfile("p1", "h1", "Adams Parent A"),
      makeProfile("p2", "h1", "Adams Parent B"),
      makeProfile("p3", "h2", "Bennett Parent"),
    ],
    rideRequests: [
      makeRideRequest("t1", "c1"),
      makeRideRequest("t1", "c2"),
      makeRideRequest("t1", "c3"),
      makeRideRequest("t1", "c4"),
    ],
    availability: [
      makeAvail("t1", "p1", "v1", "prefer"),
      makeAvail("t1", "p2", "v2", "prefer"),
      makeAvail("t1", "p3", "v3", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5, p3: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  const t1 = result.trips[0];
  assert.equal(t1.driver_count, 2, "two drivers (p1 from h1, p3 from h2)");
  assert.equal(t1.assigned_rider_count, 4, "all 4 riders covered");
  assert.equal(t1.uncovered_rider_count, 0, "coverage preserved by the second household's driver");
  assert.ok(t1.assignments.find((a) => a.driver_profile_id === "p1"), "p1 selected");
  assert.ok(t1.assignments.find((a) => a.driver_profile_id === "p3"), "p3 selected (different household)");
  assert.equal(t1.assignments.find((a) => a.driver_profile_id === "p2"), undefined, "p2 skipped — same household as p1");
});

test("shared-car: co-parents split across the week — one per trip, both can drive", async () => {
  // h1 has 2 co-parents (p1, p2) and 1 child riding each day across 2 trips.
  // Both co-parents prefer both trips. The shared-car rule applies per-trip,
  // so p1 can drive t1 and p2 can drive t2 (different trips, no conflict).
  // This confirms the rule is per-trip, not per-week.
  const { generateSchedule } = await loadGreedyModule();
  const result = generateSchedule({
    trips: [
      makeTrip("t1", "2026-08-03", "morning"),
      makeTrip("t2", "2026-08-04", "morning"),
    ],
    children: [makeChild("c1", "h1", "Ava", "Adams")],
    vehicles: [
      makeVehicle("v1", "h1", 2, "Adams car 1"),
      makeVehicle("v2", "h1", 2, "Adams car 2"),
    ],
    profiles: [
      makeProfile("p1", "h1", "Adams Parent A"),
      makeProfile("p2", "h1", "Adams Parent B"),
    ],
    rideRequests: [
      makeRideRequest("t1", "c1"),
      makeRideRequest("t2", "c1"),
    ],
    availability: [
      makeAvail("t1", "p1", "v1", "prefer"),
      makeAvail("t1", "p2", "v2", "prefer"),
      makeAvail("t2", "p1", "v1", "prefer"),
      makeAvail("t2", "p2", "v2", "prefer"),
    ],
    maxDrivesByDriver: makeMaxDrives({ p1: 5, p2: 5 }),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  });
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const t2 = result.trips.find((t) => t.trip_id === "t2");
  // Each trip: exactly one driver (single rider, cap 2, loop breaks after first).
  // t1: p1 wins by name sort (both 0 assignments). t2: p2 wins (0 vs p1's 1) —
  // load-balanced AND the shared-car rule is per-trip so p2 is allowed on t2.
  assert.equal(t1.driver_count, 1, "one driver on t1");
  assert.equal(t2.driver_count, 1, "one driver on t2");
  assert.ok(t1.assignments.find((a) => a.driver_profile_id === "p1"), "p1 drives t1 (name-sort)");
  assert.ok(t2.assignments.find((a) => a.driver_profile_id === "p2"), "p2 drives t2 (load-balanced, different trip)");
  assert.equal(t1.uncovered_rider_count, 0, "t1 covered");
  assert.equal(t2.uncovered_rider_count, 0, "t2 covered");
});