// Exchange 7 — production reliability tests.
// Source-level assertions for the ErrorBoundary, loading states, and
// retry affordances added across HomeScreen, WeekScreen, PlanScreen, and
// CoordinatorScreen.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const cssUrl = new URL("../src/prototype.css", import.meta.url);

test("Exchange 7 defines an AppErrorBoundary class component wrapping the app", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /class AppErrorBoundary extends Component/);
  assert.match(source, /static getDerivedStateFromError/);
  assert.match(source, /data-testid="error-boundary"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /<AppErrorBoundary>/);
  assert.match(source, /<\/AppErrorBoundary>/);
});

test("Exchange 7 ErrorBoundary offers a Try again recovery control", async () => {
  const source = await readFile(prototypeUrl, "utf8");
  assert.match(source, /Try again/);
  assert.match(source, /this\.setState\(\{ error: null \}\)/);
});

test("Exchange 7 HomeScreen surfaces assignments error with retry", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /assignmentsError: string \| null/);
  assert.match(source, /data-testid="retry-load-assignments"/);
  assert.match(source, /onRetryAssignments/);
  assert.match(source, /We couldn.t load your drives/);
});

test("Exchange 7 WeekScreen surfaces week and schedule errors with retry", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /weekError: string \| null;\s*schedule:/);
  assert.match(source, /scheduleError: string \| null/);
  assert.match(source, /data-testid="retry-load-week"/);
  assert.match(source, /data-testid="retry-load-schedule"/);
  assert.match(source, /onReloadWeek/);
  assert.match(source, /onReloadSchedule/);
});

test("Exchange 7 PlanScreen retry on week error reloads the week (not the checkin)", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  // The week error retry must call onReloadWeek, not onReloadCheckin.
  const weekErrorBlock = source.match(/if \(weekError\) \{[\s\S]*?Try again[\s\S]*?\}\s*\}/);
  assert.ok(weekErrorBlock, "weekError block not found");
  assert.match(weekErrorBlock[0], /onReloadWeek/);
  assert.doesNotMatch(weekErrorBlock[0], /onClick={onReloadCheckin}/);
  assert.match(source, /onReloadWeek=\{\(\) => void loadWeek\(\)\}/);
});

test("Exchange 7 CoordinatorScreen surfaces week, overview, and create-week errors with retry", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /overviewError: string \| null/);
  assert.match(source, /createWeekError: string \| null/);
  assert.match(source, /data-testid="retry-load-overview"/);
  assert.match(source, /onReloadOverview/);
  assert.match(source, /createWeekError \? <div className="auth-error" role="alert">/);
});

test("Exchange 7 state hooks capture load errors instead of swallowing them", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /setOverviewError\(readableError\(error\)\)/);
  assert.match(source, /setScheduleError\(readableError\(error\)\)/);
  assert.match(source, /setAssignmentsError\(readableError\(error\)\)/);
  assert.match(source, /setCreateWeekError\(readableError\(error\)\)/);
});

test("Exchange 7 CSS styles the error boundary and coverage-error block", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /\.error-boundary\b/);
  assert.match(css, /\.error-boundary-mark\b/);
  assert.match(css, /\.coverage-summary--error\b/);
});