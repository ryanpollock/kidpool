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
  assert.match(source, /No draft schedule yet/);
});