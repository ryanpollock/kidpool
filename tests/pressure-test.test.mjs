// Level 1: Algorithm pressure test based on PRESSURE_TEST.md
// 9 households, 12 children, 8 driving households, 10 trips.
// Pure TS — runs under --experimental-strip-types, no DB needed.

import assert from "node:assert/strict";
import test from "node:test";

const greedyUrl = new URL(
  "../supabase/functions/_shared/scheduling/balanced-greedy-v1.ts",
  import.meta.url,
);

async function loadGreedyModule() {
  const module = await import(greedyUrl);
  return { generateSchedule: module.generateSchedule };
}

// ── Pressure test scenario (from PRESSURE_TEST.md) ──────────────
//
// Household   Children   Seats   MaxDrives
// Adams       2          4       3
// Bennett     1          3       4
// Chen        2          5       5
// Diaz        1          0       0   (does not drive)
// Evans       1          3       2
// Foster      1          4       5
// Garcia      2          3       4
// Hughes      1          4       5
// Irwin       1          3       3
//
// Expected riders per trip:
// Mon AM 12, Mon PM 10, Tue AM 12, Tue PM 12,
// Wed AM 11, Wed PM 9,  Thu AM 12, Thu PM 12,
// Fri AM 12, Fri PM 8

const householdIds = {
  adams: "h-adams",
  bennett: "h-bennett",
  chen: "h-chen",
  diaz: "h-diaz",
  evans: "h-evans",
  foster: "h-foster",
  garcia: "h-garcia",
  hughes: "h-hughes",
  irwin: "h-irwin",
};

const profileIds = {
  adams: "p-adams",
  bennett: "p-bennett",
  chen: "p-chen",
  diaz: "p-diaz",
  evans: "p-evans",
  foster: "p-foster",
  garcia: "p-garcia",
  hughes: "p-hughes",
  irwin: "p-irwin",
};

const vehicleIds = {
  adams: "v-adams",
  bennett: "v-bennett",
  chen: "v-chen",
  evans: "v-evans",
  foster: "v-foster",
  garcia: "v-garcia",
  hughes: "v-hughes",
  irwin: "v-irwin",
};

function buildChildren() {
  return [
    { id: "c-adams-1", household_id: householdIds.adams, first_name: "A1", last_name: "Adams" },
    { id: "c-adams-2", household_id: householdIds.adams, first_name: "A2", last_name: "Adams" },
    { id: "c-bennett-1", household_id: householdIds.bennett, first_name: "B1", last_name: "Bennett" },
    { id: "c-chen-1", household_id: householdIds.chen, first_name: "C1", last_name: "Chen" },
    { id: "c-chen-2", household_id: householdIds.chen, first_name: "C2", last_name: "Chen" },
    { id: "c-diaz-1", household_id: householdIds.diaz, first_name: "D1", last_name: "Diaz" },
    { id: "c-evans-1", household_id: householdIds.evans, first_name: "E1", last_name: "Evans" },
    { id: "c-foster-1", household_id: householdIds.foster, first_name: "F1", last_name: "Foster" },
    { id: "c-garcia-1", household_id: householdIds.garcia, first_name: "G1", last_name: "Garcia" },
    { id: "c-garcia-2", household_id: householdIds.garcia, first_name: "G2", last_name: "Garcia" },
    { id: "c-hughes-1", household_id: householdIds.hughes, first_name: "H1", last_name: "Hughes" },
    { id: "c-irwin-1", household_id: householdIds.irwin, first_name: "I1", last_name: "Irwin" },
  ];
}

function buildVehicles() {
  return [
    { id: vehicleIds.adams, household_id: householdIds.adams, label: "Adams", child_passenger_capacity: 4 },
    { id: vehicleIds.bennett, household_id: householdIds.bennett, label: "Bennett", child_passenger_capacity: 3 },
    { id: vehicleIds.chen, household_id: householdIds.chen, label: "Chen", child_passenger_capacity: 5 },
    { id: vehicleIds.evans, household_id: householdIds.evans, label: "Evans", child_passenger_capacity: 3 },
    { id: vehicleIds.foster, household_id: householdIds.foster, label: "Foster", child_passenger_capacity: 4 },
    { id: vehicleIds.garcia, household_id: householdIds.garcia, label: "Garcia", child_passenger_capacity: 3 },
    { id: vehicleIds.hughes, household_id: householdIds.hughes, label: "Hughes", child_passenger_capacity: 4 },
    { id: vehicleIds.irwin, household_id: householdIds.irwin, label: "Irwin", child_passenger_capacity: 3 },
  ];
}

function buildProfiles() {
  return Object.entries(profileIds).map(([name, id]) => ({
    id,
    full_name: `${name.charAt(0).toUpperCase()}${name.slice(1)} Parent`,
    household_id: householdIds[name],
  }));
}

function buildTrips() {
  const trips = [];
  const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
  for (let d = 0; d < 5; d++) {
    trips.push({ id: `t-${d}-am`, service_date: dates[d], direction: "morning" });
    trips.push({ id: `t-${d}-pm`, service_date: dates[d], direction: "afternoon" });
  }
  return trips;
}

function buildRideRequests(trips, children) {
  // Rider counts per trip from PRESSURE_TEST.md:
  // Mon AM 12, Mon PM 10, Tue AM 12, Tue PM 12, Wed AM 11, Wed PM 9,
  // Thu AM 12, Thu PM 12, Fri AM 12, Fri PM 8
  const riderCounts = {
    "t-0-am": 12, "t-0-pm": 10,
    "t-1-am": 12, "t-1-pm": 12,
    "t-2-am": 11, "t-2-pm": 9,
    "t-3-am": 12, "t-3-pm": 12,
    "t-4-am": 12, "t-4-pm": 8,
  };

  const requests = [];
  for (const trip of trips) {
    const count = riderCounts[trip.id] ?? 12;
    // Take first `count` children in sorted order
    const sorted = [...children].sort((a, b) =>
      `${a.household_id}|${a.first_name}`.localeCompare(`${b.household_id}|${b.first_name}`),
    );
    for (let i = 0; i < count; i++) {
      requests.push({ trip_id: trip.id, child_id: sorted[i].id, needs_ride: true });
    }
  }
  return requests;
}

function buildAvailability(trips) {
  // 8 driving households provide availability across 10 trips.
  // Diaz does not drive. All 8 others respond with availability.
  // Each driver marks prefer on some trips, can on others.
  const drivers = [
    "adams", "bennett", "chen", "evans", "foster", "garcia", "hughes", "irwin",
  ];

  const availability = [];
  for (const driver of drivers) {
    const pid = profileIds[driver];
    const vid = vehicleIds[driver];
    for (let d = 0; d < 5; d++) {
      // Morning: prefer on days 0,2,4; can on days 1,3
      const morningPref = d % 2 === 0 ? "prefer" : "can";
      availability.push({ trip_id: `t-${d}-am`, driver_profile_id: pid, vehicle_id: vid, preference: morningPref });
      // Afternoon: prefer on days 1,3; can on days 0,2,4
      const afternoonPref = d % 2 === 1 ? "prefer" : "can";
      availability.push({ trip_id: `t-${d}-pm`, driver_profile_id: pid, vehicle_id: vid, preference: afternoonPref });
    }
  }
  return availability;
}

function buildMaxDrives() {
  return new Map([
    [profileIds.adams, 3],
    [profileIds.bennett, 4],
    [profileIds.chen, 5],
    [profileIds.diaz, 0],
    [profileIds.evans, 2],
    [profileIds.foster, 5],
    [profileIds.garcia, 4],
    [profileIds.hughes, 5],
    [profileIds.irwin, 3],
  ]);
}

function buildPressureInputs() {
  const trips = buildTrips();
  const children = buildChildren();
  return {
    trips,
    children,
    vehicles: buildVehicles(),
    profiles: buildProfiles(),
    rideRequests: buildRideRequests(trips, children),
    availability: buildAvailability(trips),
    maxDrivesByDriver: buildMaxDrives(),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
}

// ── Tests ────────────────────────────────────────────────────────

test("pressure: most trips are covered (Friday PM may be uncovered due to drive limits)", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());

  let coveredCount = 0;
  for (const trip of outputs.trips) {
    if (trip.uncovered_rider_count === 0) coveredCount++;
  }

  // 9 of 10 trips should be fully covered. Friday PM (last trip) may
  // have some uncovered riders because the total weekly drive limit
  // across 8 driving households is 31, and 10 trips × ~3 drivers = ~30.
  assert.ok(coveredCount >= 9, `Only ${coveredCount}/10 trips covered — algorithm should cover at least 9`);
});

test("pressure: no vehicle is ever overfilled", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());

  for (const trip of outputs.trips) {
    for (const assignment of trip.assignments) {
      assert.ok(
        assignment.assigned_child_ids.length <= assignment.child_passenger_capacity,
        `Trip ${trip.trip_id}: driver ${assignment.driver_profile_id} has ${assignment.assigned_child_ids.length} children but capacity ${assignment.child_passenger_capacity}`,
      );
    }
  }
});

test("pressure: weekly drive limits are respected for every household", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());
  const maxDrives = buildMaxDrives();

  const driveCounts = new Map();
  for (const trip of outputs.trips) {
    for (const assignment of trip.assignments) {
      driveCounts.set(
        assignment.driver_profile_id,
        (driveCounts.get(assignment.driver_profile_id) ?? 0) + 1,
      );
    }
  }

  for (const [driverId, count] of driveCounts) {
    const limit = maxDrives.get(driverId) ?? 0;
    assert.ok(
      count <= limit,
      `Driver ${driverId} has ${count} assignments but limit is ${limit}`,
    );
  }
});

test("pressure: drivers' own children are prioritized when possible", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());
  const children = buildChildren();
  const profiles = buildProfiles();
  const driverHousehold = new Map(profiles.map((p) => [p.id, p.household_id]));

  const inputs = buildPressureInputs();
  let ownChildAssignedToParent = 0;
  let totalOwnChildOpportunities = 0;

  for (const trip of outputs.trips) {
    const tripRiders = inputs.rideRequests
      .filter((r) => r.trip_id === trip.trip_id && r.needs_ride)
      .map((r) => children.find((c) => c.id === r.child_id))
      .filter((c) => c !== undefined);

    for (const assignment of trip.assignments) {
      const dHousehold = driverHousehold.get(assignment.driver_profile_id);
      if (!dHousehold) continue;
      const ownRiders = tripRiders.filter((c) => c && c.household_id === dHousehold);
      if (ownRiders.length === 0) continue;

      totalOwnChildOpportunities += ownRiders.length;
      for (const ownChild of ownRiders) {
        if (assignment.assigned_child_ids.includes(ownChild.id)) {
          ownChildAssignedToParent++;
        }
      }
    }
  }

  // The greedy algorithm doesn't guarantee 100% own-child-with-parent
  // (a child may be assigned to an earlier-processed driver), but most
  // should be. At least 60% of own children should ride with their parent.
  assert.ok(
    ownChildAssignedToParent / totalOwnChildOpportunities >= 0.6,
    `Only ${ownChildAssignedToParent}/${totalOwnChildOpportunities} own children assigned to their parent`,
  );
});

test("pressure: drive counts are reasonably balanced across households", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());

  const driveCounts = new Map();
  for (const trip of outputs.trips) {
    for (const assignment of trip.assignments) {
      driveCounts.set(
        assignment.driver_profile_id,
        (driveCounts.get(assignment.driver_profile_id) ?? 0) + 1,
      );
    }
  }

  const counts = [...driveCounts.values()];
  const max = Math.max(...counts);
  const min = Math.min(...counts);

  // No household should do more than 7 of ~30 total driving assignments
  assert.ok(max <= 7, `Max drive count ${max} is too high — unfair distribution`);
  // Every driving household should have at least 1 assignment
  assert.ok(min >= 1, `Min drive count ${min} — some willing driver got zero assignments`);
});

test("pressure: seat count meets or exceeds assigned rider count for every trip", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());

  for (const trip of outputs.trips) {
    assert.ok(
      trip.seat_count >= trip.assigned_rider_count,
      `Trip ${trip.trip_id}: seats ${trip.seat_count} < assigned riders ${trip.assigned_rider_count}`,
    );
  }
});

test("pressure: deterministic — same inputs produce identical outputs", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const run1 = generateSchedule(buildPressureInputs());
  const run2 = generateSchedule(buildPressureInputs());
  assert.deepEqual(run1, run2);
});

test("pressure: total assigned riders is at least 100 of 110 expected", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildPressureInputs());

  // Expected rider counts: 12+10+12+12+11+9+12+12+12+8 = 110
  // With 31 total drive slots across 8 drivers, the algorithm should
  // cover at least 100 of 110 riders (90%+).
  const actualTotal = outputs.trips.reduce((sum, t) => sum + t.assigned_rider_count, 0);
  assert.ok(
    actualTotal >= 100,
    `Total assigned riders ${actualTotal} is too low — expected at least 100 of 110`,
  );
});