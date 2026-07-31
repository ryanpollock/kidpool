import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const repositoryUrl = new URL(
  "../src/lib/supabase/carpool-repository.ts",
  import.meta.url,
);

test("Exchange 4 repository exposes week, check-in, ride request, and driver availability methods", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /async listWeeks\(/);
  assert.match(source, /async getCurrentWeek\(/);
  assert.match(source, /async createWeekWithTrips\(/);
  assert.match(source, /async getOrCreateCheckin\(/);
  assert.match(source, /async getCheckinDetails\(/);
  assert.match(source, /async submitCheckin\(/);
  assert.match(source, /async reopenCheckin\(/);
  assert.match(source, /async upsertRideRequest\(/);
  assert.match(source, /async upsertDriverAvailability\(/);
  assert.match(source, /async getWeekOverview\(/);
  assert.match(source, /from\("weeks"\)/);
  assert.match(source, /from\("trips"\)/);
  assert.match(source, /from\("weekly_checkins"\)/);
  assert.match(source, /from\("ride_requests"\)/);
  assert.match(source, /from\("driver_availability"\)/);
});

test("Exchange 4 repository enforces drive preference and vehicle constraints", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /preference === "cannot" \? null : vehicleId/);
  assert.match(source, /DrivePreference/);
  assert.match(source, /needs_ride/);
  assert.match(source, /driver_profile_id/);
});

test("Exchange 4 plan screen is DB-backed with real week, trips, and check-in", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="plan-screen"/);
  assert.match(source, /data-testid="submit-plan"/);
  assert.match(source, /WeekWithTrips/);
  assert.match(source, /CheckinDetails/);
  assert.match(source, /upsertRideRequest/);
  assert.match(source, /upsertDriverAvailability/);
  assert.match(source, /submitCheckin/);
  assert.match(source, /reopenCheckin/);
  assert.match(source, /rideMap/);
  assert.match(source, /driveMap/);
  assert.match(source, /cycleDrivePreference/);
  assert.match(source, /preferenceLabel/);
});

test("Exchange 4 plan screen handles no-week and no-children states", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /No week has been created yet/);
  assert.match(source, /Create next week/);
  assert.match(source, /Add your children in your account first/);
  assert.match(source, /data-testid="create-week-plan"/);
});

test("Exchange 4 coordinator screen shows real overview and week creation", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /data-testid="coordinator-screen"/);
  assert.match(source, /data-testid="create-week-coord"/);
  assert.match(source, /WeekOverview/);
  assert.match(source, /getWeekOverview/);
  assert.match(source, /household-status-row/);
  assert.match(source, /status-chip status-chip--\$\{h\.status\}/);
  assert.match(source, /status === "submitted"/);
  assert.match(source, /status === "draft"/);
  assert.match(source, /Household responses/);
  assert.match(source, /Trip demand/);
});

test("Exchange 4 creates weeks with default meeting and departure times", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /meeting_time: "08:40"/);
  assert.match(source, /departure_time: "08:45"/);
  assert.match(source, /meeting_time: "17:15"/);
  assert.match(source, /departure_time: "17:20"/);
  assert.match(source, /direction: "morning"/);
  assert.match(source, /direction: "afternoon"/);
  assert.match(source, /offset < 5/);
});