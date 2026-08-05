import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const greedyUrl = new URL(
  "../supabase/functions/_shared/scheduling/greedy-v1.ts",
  import.meta.url,
);
const typesUrl = new URL(
  "../supabase/functions/_shared/scheduling/types.ts",
  import.meta.url,
);
const edgeFunctionUrl = new URL(
  "../supabase/functions/generate-schedule/index.ts",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);
const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);

// Load the greedy algorithm. The module has zero runtime imports so it
// works under Node's --experimental-strip-types flag. The package.json
// test:foundation script runs node with that flag for scheduling tests.
async function loadGreedyModule() {
  const module = await import(greedyUrl);
  return { generateSchedule: module.generateSchedule, ALGORITHM_VERSION: module.ALGORITHM_VERSION };
}

function buildInputs() {
  return {
    trips: [
      { id: "t1", service_date: "2026-08-03", direction: "morning" },
      { id: "t2", service_date: "2026-08-03", direction: "afternoon" },
    ],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams" },
      { id: "c2", household_id: "h1", first_name: "Ben", last_name: "Adams" },
      { id: "c3", household_id: "h2", first_name: "Cleo", last_name: "Bennett" },
      { id: "c4", household_id: "h2", first_name: "Dan", last_name: "Bennett" },
      { id: "c5", household_id: "h3", first_name: "Eve", last_name: "Chen" },
    ],
    vehicles: [
      { id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 3 },
      { id: "v2", household_id: "h2", label: "Bennett car", child_passenger_capacity: 2 },
      { id: "v3", household_id: "h3", label: "Chen car", child_passenger_capacity: 2 },
    ],
    profiles: [
      { id: "p1", full_name: "Adams Parent", household_id: "h1" },
      { id: "p2", full_name: "Bennett Parent", household_id: "h2" },
      { id: "p3", full_name: "Chen Parent", household_id: "h3" },
    ],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
      { trip_id: "t1", child_id: "c4", needs_ride: true },
      { trip_id: "t1", child_id: "c5", needs_ride: true },
      { trip_id: "t2", child_id: "c1", needs_ride: true },
      { trip_id: "t2", child_id: "c3", needs_ride: true },
    ],
    availability: [
      { trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" },
      { trip_id: "t1", driver_profile_id: "p2", vehicle_id: "v2", preference: "can" },
      { trip_id: "t2", driver_profile_id: "p3", vehicle_id: "v3", preference: "prefer" },
    ],
    maxDrivesByDriver: new Map([
      ["p1", 5], ["p2", 5], ["p3", 5],
    ]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
}

test("greedy-v1 covers all riders when capacity is sufficient", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildInputs());

  const trip1 = outputs.trips.find((t) => t.trip_id === "t1");
  assert.ok(trip1);
  assert.equal(trip1.uncovered_rider_count, 0);
  assert.equal(trip1.rider_count, 5);
  assert.equal(trip1.assigned_rider_count, 5);
});

test("greedy-v1 prefers prefer-drivers over can-drivers", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildInputs());

  const trip1 = outputs.trips.find((t) => t.trip_id === "t1");
  assert.ok(trip1);
  const adamsAssignment = trip1.assignments.find((a) => a.driver_profile_id === "p1");
  assert.ok(adamsAssignment, "prefer driver p1 should be assigned");
  assert.ok(adamsAssignment.assigned_child_ids.length > 0);
});

test("greedy-v1 counts driver's own children against capacity", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildInputs());

  const trip1 = outputs.trips.find((t) => t.trip_id === "t1");
  assert.ok(trip1);
  const adamsAssignment = trip1.assignments.find((a) => a.driver_profile_id === "p1");
  assert.ok(adamsAssignment);
  // Adams has 2 own children riding (c1, c2), capacity 3 → 1 other child
  assert.equal(adamsAssignment.assigned_child_ids.length, 3);
  assert.ok(adamsAssignment.assigned_child_ids.includes("c1"));
  assert.ok(adamsAssignment.assigned_child_ids.includes("c2"));
});

test("greedy-v1 leaves trips uncovered when capacity is insufficient", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  // Remove Bennett driver availability so only Adams (3 seats) for 5 riders
  inputs.availability = inputs.availability.filter((a) => a.driver_profile_id !== "p2");
  const outputs = generateSchedule(inputs);

  const trip1 = outputs.trips.find((t) => t.trip_id === "t1");
  assert.ok(trip1);
  assert.ok(trip1.uncovered, "trip should be uncovered");
  assert.equal(trip1.uncovered_rider_count, 2);
  assert.equal(trip1.assigned_rider_count, 3);
});

test("greedy-v1 is deterministic — same inputs produce identical outputs", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const run1 = generateSchedule(buildInputs());
  const run2 = generateSchedule(buildInputs());
  assert.deepEqual(run1, run2);
});

test("greedy-v1 never assigns a cannot driver", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  inputs.availability = [
    { trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "cannot" },
    { trip_id: "t1", driver_profile_id: "p2", vehicle_id: "v2", preference: "prefer" },
  ];
  const outputs = generateSchedule(inputs);
  const trip1 = outputs.trips.find((t) => t.trip_id === "t1");
  assert.ok(trip1);
  const adamsAssignment = trip1.assignments.find((a) => a.driver_profile_id === "p1");
  assert.equal(adamsAssignment, undefined, "cannot driver should never be assigned");
});

test("greedy-v1 never overfills a vehicle", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const outputs = generateSchedule(buildInputs());
  for (const trip of outputs.trips) {
    for (const assignment of trip.assignments) {
      assert.ok(
        assignment.assigned_child_ids.length <= assignment.child_passenger_capacity,
        `vehicle ${assignment.vehicle_id} overfilled: ${assignment.assigned_child_ids.length} > ${assignment.child_passenger_capacity}`,
      );
    }
  }
});

test("greedy-v1 respects weekly drive limits", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  // p1 max 1 drive, but available for both trips
  inputs.maxDrivesByDriver.set("p1", 1);
  inputs.availability.push({ trip_id: "t2", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" });
  const outputs = generateSchedule(inputs);
  const p1Assignments = outputs.trips.flatMap((t) =>
    t.assignments.filter((a) => a.driver_profile_id === "p1"),
  );
  assert.equal(p1Assignments.length, 1, "p1 should only get 1 assignment due to weekly limit");
});

test("Exchange 5 algorithm version is greedy-v1", async () => {
  const source = await readFile(greedyUrl, "utf8");
  assert.match(source, /ALGORITHM_VERSION = "greedy-v1"/);
});

test("Exchange 5 scheduling types module has zero imports", async () => {
  const source = await readFile(typesUrl, "utf8");
  assert.doesNotMatch(source, /^import /m);
});

test("Exchange 5 edge function invokes the greedy algorithm and writes a version", async () => {
  const source = await readFile(edgeFunctionUrl, "utf8");

  assert.match(source, /generateSchedule/);
  assert.match(source, /ALGORITHM_VERSION/);
  assert.match(source, /schedule_versions/);
  assert.match(source, /driver_assignments/);
  assert.match(source, /rider_assignments/);
  assert.match(source, /coordinator/);
  assert.match(source, /superseded/);
});

test("Exchange 5 repository exposes generate and read methods for schedules", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /async generateDraftSchedule\(/);
  assert.match(source, /async getLatestScheduleVersion\(/);
  assert.match(source, /async getGroupRoster\(/);
  assert.match(source, /functions\.invoke\("generate-schedule"/);
  assert.match(source, /ScheduleVersionWithRosters/);
  assert.match(source, /ScheduleRosterEntry/);
});

test("Exchange 5 WeekScreen renders real schedule with rosters and coverage states", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="week-screen"/);
  assert.match(source, /data-testid="generate-schedule"/);
  assert.match(source, /data-testid="regenerate-schedule"/);
  assert.match(source, /ScheduleVersionWithRosters/);
  assert.match(source, /rostersByTrip/);
  assert.match(source, /trip-roster/);
  assert.match(source, /roster-driver/);
  assert.match(source, /roster-children/);
  assert.match(source, /No drivers/);
  assert.match(source, /No schedule published yet/);
});

// ── Regression tests for confirmed-driver preservation and decline/expired exclusion ──

test("regression: confirmed driver at max_drives is preserved on their confirmed trip", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  // p1 confirmed trip t1, max_drives = 1 (already at limit)
  inputs.maxDrivesByDriver = new Map([["p1", 1], ["p2", 5], ["p3", 5]]);
  inputs.existingAssignments = [
    { trip_id: "t1", driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 3, confirmed: true },
  ];
  const result = generateSchedule(inputs);

  // p1 should be preserved on t1 despite being at max_drives
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.ok(p1Assignment, "p1 should have an assignment on t1");
  assert.equal(p1Assignment.confirmed, true, "p1 assignment should be confirmed");

  // t1 should have coverage (p1 is driving)
  assert.equal(t1?.uncovered, false, "t1 should not be uncovered");

  // t2: p1 is at max_drives and not confirmed for t2, so should NOT be assigned
  const t2 = result.trips.find((t) => t.trip_id === "t2");
  const p1OnT2 = t2?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.equal(p1OnT2, undefined, "p1 should NOT be assigned to t2 (at max_drives)");
});

test("regression: declined driver is not re-offered the same trip", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  // p1 declined trip t1 in a prior version
  inputs.declinedTripsByDriver = new Map([["p1", new Set(["t1"])]]);
  const result = generateSchedule(inputs);

  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.equal(p1Assignment, undefined, "p1 should NOT be assigned to t1 (declined)");

  // p1 should still be available for other trips they didn't decline
  const t2 = result.trips.find((t) => t.trip_id === "t2");
  const p1OnT2 = t2?.assignments.find((a) => a.driver_profile_id === "p1");
  // p1 has no availability for t2 in buildInputs, so this is expected undefined
  assert.equal(p1OnT2, undefined, "p1 has no availability for t2");
});

test("regression: expired driver is not re-offered the same trip", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  // p3 let trip t2 expire in a prior version
  inputs.expiredTripsByDriver = new Map([["p3", new Set(["t2"])]]);
  const result = generateSchedule(inputs);

  const t2 = result.trips.find((t) => t.trip_id === "t2");
  const p3Assignment = t2?.assignments.find((a) => a.driver_profile_id === "p3");
  assert.equal(p3Assignment, undefined, "p3 should NOT be assigned to t2 (expired)");

  // t2 should be uncovered since p3 was the only driver available
  assert.equal(t2?.uncovered, true, "t2 should be uncovered");
  assert.ok(t2 && t2.uncovered_rider_count > 0, "t2 should have uncovered riders");
});

test("regression: confirmed driver with trip_id is correctly keyed", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = buildInputs();
  // Two confirmed assignments for different trips, same driver
  inputs.maxDrivesByDriver = new Map([["p1", 5], ["p2", 5], ["p3", 5]]);
  inputs.existingAssignments = [
    { trip_id: "t1", driver_profile_id: "p1", household_id: "h1", vehicle_id: "v1", child_passenger_capacity: 3, confirmed: true },
    { trip_id: "t2", driver_profile_id: "p3", household_id: "h3", vehicle_id: "v3", child_passenger_capacity: 2, confirmed: true },
  ];
  const result = generateSchedule(inputs);

  // Both confirmed drivers should be preserved on their respective trips
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const t2 = result.trips.find((t) => t.trip_id === "t2");

  const p1OnT1 = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  const p3OnT2 = t2?.assignments.find((a) => a.driver_profile_id === "p3");

  assert.ok(p1OnT1, "p1 should be preserved on t1");
  assert.equal(p1OnT1?.confirmed, true, "p1 on t1 should be confirmed");
  assert.ok(p3OnT2, "p3 should be preserved on t2");
  assert.equal(p3OnT2?.confirmed, true, "p3 on t2 should be confirmed");
});

test("regression: driving parent is selected before non-parent driver so their kid rides with them", async () => {
  const { generateSchedule } = await loadGreedyModule();
  const inputs = {
    trips: [
      { id: "t1", service_date: "2026-08-03", direction: "morning" },
    ],
    children: [
      { id: "c1", household_id: "h1", first_name: "Kid", last_name: "Parent" },
    ],
    vehicles: [
      { id: "v1", household_id: "h2", label: "Stranger car", child_passenger_capacity: 4 },
      { id: "v2", household_id: "h1", label: "Parent car", child_passenger_capacity: 4 },
    ],
    profiles: [
      { id: "p1", full_name: "Stranger Driver", household_id: "h2" },
      { id: "p2", full_name: "Parent Driver", household_id: "h1" },
    ],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
    ],
    availability: [
      // Stranger prefers to drive, parent only "can" — but parent has own kid
      { trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" },
      { trip_id: "t1", driver_profile_id: "p2", vehicle_id: "v2", preference: "can" },
    ],
    maxDrivesByDriver: new Map([["p1", 5], ["p2", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };

  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");

  // p2 (parent) should be selected as driver despite p1 having higher preference
  const p2Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p2");
  assert.ok(p2Assignment, "parent driver p2 should be selected");
  assert.ok(
    p2Assignment?.assigned_child_ids.includes("c1"),
    "parent's child c1 should be in their car",
  );

  // p1 (stranger with prefer) should NOT be driving this trip
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.equal(p1Assignment, undefined, "stranger p1 should not be driving when parent is available");
});

// ── Riding buddy tests ────────────────────────────────────────────
// The buddy feature gives priority to children whose preferred_buddy_child_id
// is already in the car. Tests use the while-loop pick-best-remaining path.

test("buddy: child whose buddy is already in the car gets priority over name sort", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Driver from h1 has 1 own child c1. Two other children need rides.
  // c3 has buddy=c1 (will be in car as own child). c2 has no buddy.
  // Capacity is 2 (own + 1 other). c2 sorts before c3 alphabetically
  // ("Ben Adams" < "Cleo Bennett"), but c3 should win because its buddy c1 is in the car.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: null },
      { id: "c3", household_id: "h3", first_name: "Cleo", last_name: "Chen", preferred_buddy_child_id: "c1" },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.ok(p1Assignment, "p1 should be assigned");
  assert.deepEqual(p1Assignment?.assigned_child_ids, ["c1", "c3"], "c3 (buddy=c1) should win over c2 despite name sort");
  assert.equal(t1?.uncovered_rider_count, 1, "c2 should be uncovered (capacity reached)");
});

test("buddy: no overflow — capacity respected even when buddy priority applies", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Driver capacity 1, only 1 own child. Two other children both have buddy=c1.
  // Only 1 can ride (the own child). Neither other fits because capacity is 1.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: "c1" },
      { id: "c3", household_id: "h3", first_name: "Cleo", last_name: "Chen", preferred_buddy_child_id: "c1" },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 1 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.deepEqual(p1Assignment?.assigned_child_ids, ["c1"], "only own child fits");
  assert.equal(t1?.uncovered_rider_count, 2, "two others should be uncovered");
});

test("buddy: buddy not riding this trip — no buddy advantage, falls back to name sort", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // c3's buddy is c1, but c1 does NOT need a ride this trip.
  // c3 should get no priority advantage and the algorithm should pick by name sort.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: null },
      { id: "c3", household_id: "h3", first_name: "Cleo", last_name: "Chen", preferred_buddy_child_id: "c1" },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      // c1 NOT requesting — buddy not in car
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  // Both c2 and c3 fit (capacity 2, no own children riding)
  assert.deepEqual(
    p1Assignment?.assigned_child_ids.sort(),
    ["c2", "c3"].sort(),
    "both riders should be assigned when capacity allows",
  );
});

test("buddy: own children always assigned first even when buddy points to non-own child", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Driver from h1 has own child c1. c2 (other household) has buddy=c1.
  // c3 (other household) has no buddy. Capacity 2 (own + 1 other).
  // Own child c1 must always be assigned first. Then c2 wins (buddy in car).
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: "c1" },
      { id: "c3", household_id: "h3", first_name: "Cleo", last_name: "Chen", preferred_buddy_child_id: null },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.ok(p1Assignment?.assigned_child_ids.includes("c1"), "own child c1 must be in car");
  assert.ok(p1Assignment?.assigned_child_ids.includes("c2"), "buddy c2 should be in car (buddy=c1)");
  assert.equal(p1Assignment?.assigned_child_ids.length, 2, "capacity 2 respected");
  assert.equal(t1?.uncovered_rider_count, 1, "c3 should be uncovered");
});

test("buddy: third-party driver carries both buddy-paired children when capacity allows", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // Third-party driver from h3. c1 (h1) and c2 (h2) both need rides.
  // c2 has buddy=c1. When the algorithm picks the first "other" child for h3's car,
  // c1 has no buddy-in-car (nothing in car yet). c2 has no buddy-in-car either (c1 not yet picked).
  // So initial pick is by name sort. Once c1 is in the car, c2's buddy=c1 is now in car
  // and c2 should win any subsequent tiebreak. With capacity 2, both fit regardless.
  // This test confirms no crash and both are assigned.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: "c1" },
      { id: "c4", household_id: "h2", first_name: "Dana", last_name: "Bennett", preferred_buddy_child_id: null },
    ],
    vehicles: [{ id: "v3", household_id: "h3", label: "Chen car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p3", full_name: "Chen Parent", household_id: "h3" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c4", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p3", vehicle_id: "v3", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p3", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p3Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p3");
  assert.ok(p3Assignment, "p3 should be assigned");
  // First pick: c1 (no buddy in car, but sorts first by name "Ava Adams").
  // Second pick: c2 now has buddy c1 in car — wins over c4.
  assert.deepEqual(p3Assignment?.assigned_child_ids, ["c1", "c2"], "c2 should win second slot because buddy c1 is in car");
  assert.equal(t1?.uncovered_rider_count, 1, "c4 uncovered");
});

test("buddy: stale buddy ID not in children list — graceful, no effect", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // c2 has buddy=c99 which does not exist in the children list.
  // assignedSet.has("c99") is always false, so no buddy advantage.
  // Should behave identically to no buddy.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: "c99" },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.deepEqual(
    p1Assignment?.assigned_child_ids.sort(),
    ["c1", "c2"].sort(),
    "stale buddy should not affect assignment",
  );
  assert.equal(t1?.uncovered_rider_count, 0, "all riders covered");
});

test("priority: priority child wins tight seat over name-sorted peer", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // 1 driver from h1, capacity 2. Own child c1 + two others need rides.
  // "Ben Adams" sorts before "Sara Pollock" alphabetically, but Sara is
  // priority. With capacity 2 (own + 1 other), Sara should win the seat.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Adams", preferred_buddy_child_id: null, is_priority: false },
      { id: "c3", household_id: "h3", first_name: "Sara", last_name: "Pollock", preferred_buddy_child_id: null, is_priority: true },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.deepEqual(p1Assignment?.assigned_child_ids, ["c1", "c3"], "priority child Sara should win the seat over Ben despite name sort");
  assert.equal(t1?.uncovered_rider_count, 1, "Ben should be uncovered (capacity reached)");
});

test("priority: priority child wins over another child's buddy-in-car advantage", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // 1 driver from h1, capacity 2. Own child c1. Two others:
  //   c2 has buddy=c1 (will be in car as own child) — would normally win via buddy-in-car
  //   c3 is priority, no buddy
  // Priority is the first tiebreaker, so c3 wins over c2's buddy advantage.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: "c1" },
      { id: "c3", household_id: "h3", first_name: "Sara", last_name: "Pollock", preferred_buddy_child_id: null, is_priority: true },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 2 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.deepEqual(p1Assignment?.assigned_child_ids, ["c1", "c3"], "priority child c3 should win over c2's buddy-in-car advantage");
  assert.equal(t1?.uncovered_rider_count, 1, "c2 should be uncovered (priority beat buddy)");
});

test("priority: multiple seats available — priority child covered, no regression", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // 1 driver, capacity 4. 4 riders including 1 priority. All should be covered.
  const inputs = {
    trips: [{ id: "t1", service_date: "2026-08-03", direction: "morning" }],
    children: [
      { id: "c1", household_id: "h1", first_name: "Ava", last_name: "Adams", preferred_buddy_child_id: null },
      { id: "c2", household_id: "h2", first_name: "Ben", last_name: "Bennett", preferred_buddy_child_id: null },
      { id: "c3", household_id: "h3", first_name: "Cleo", last_name: "Chen", preferred_buddy_child_id: null },
      { id: "c4", household_id: "h4", first_name: "Sara", last_name: "Pollock", preferred_buddy_child_id: null, is_priority: true },
    ],
    vehicles: [{ id: "v1", household_id: "h1", label: "Adams car", child_passenger_capacity: 4 }],
    profiles: [{ id: "p1", full_name: "Adams Parent", household_id: "h1" }],
    rideRequests: [
      { trip_id: "t1", child_id: "c1", needs_ride: true },
      { trip_id: "t1", child_id: "c2", needs_ride: true },
      { trip_id: "t1", child_id: "c3", needs_ride: true },
      { trip_id: "t1", child_id: "c4", needs_ride: true },
    ],
    availability: [{ trip_id: "t1", driver_profile_id: "p1", vehicle_id: "v1", preference: "prefer" }],
    maxDrivesByDriver: new Map([["p1", 5]]),
    existingAssignments: [],
    declinedTripsByDriver: new Map(),
    expiredTripsByDriver: new Map(),
  };
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  const p1Assignment = t1?.assignments.find((a) => a.driver_profile_id === "p1");
  assert.equal(p1Assignment?.assigned_child_ids.length, 4, "all 4 riders should be assigned");
  assert.ok(p1Assignment?.assigned_child_ids.includes("c4"), "priority child should be assigned");
  assert.equal(t1?.uncovered_rider_count, 0, "no uncovered riders");
});

test("priority: is_priority omitted = identical to today (backward compat)", async () => {
  const { generateSchedule } = await loadGreedyModule();
  // buildInputs() does not set is_priority on any child. Behavior should be
  // identical to pre-priority-feature: all children treated as non-priority.
  const inputs = buildInputs();
  const result = generateSchedule(inputs);
  const t1 = result.trips.find((t) => t.trip_id === "t1");
  // The existing "covers all riders when capacity is sufficient" test asserts
  // all 5 riders on t1 are covered. Verify the same holds.
  assert.equal(t1?.rider_count, 5, "should see all 5 riders");
  assert.equal(t1?.uncovered_rider_count, 0, "all riders covered (no priority field set)");
  assert.equal(t1?.assigned_rider_count, 5, "all assigned");
});