export const NO_SCHOOL_DATES: ReadonlyMap<string, string> = new Map([
  ["2026-08-17", "First day of school"],
  ["2026-09-07", "Labor Day"],
  ["2026-10-12", "Indigenous Peoples' Day"],
  ["2026-11-11", "Veterans Day"],
  ["2026-11-23", "Thanksgiving Break"],
  ["2026-11-24", "Thanksgiving Break"],
  ["2026-11-25", "Thanksgiving Break"],
  ["2026-11-26", "Thanksgiving Break"],
  ["2026-11-27", "Thanksgiving Break"],
  ["2026-12-21", "Winter Break"],
  ["2026-12-22", "Winter Break"],
  ["2026-12-23", "Winter Break"],
  ["2026-12-24", "Winter Break"],
  ["2026-12-25", "Winter Break"],
  ["2026-12-28", "Winter Break"],
  ["2026-12-29", "Winter Break"],
  ["2026-12-30", "Winter Break"],
  ["2026-12-31", "Winter Break"],
  ["2027-01-01", "New Year's Day"],
  ["2027-01-18", "MLK Jr. Day"],
  ["2027-02-05", "Lunar New Year"],
  ["2027-02-15", "Presidents' Day"],
  ["2027-03-26", "Spring Break"],
  ["2027-03-29", "Spring Break"],
  ["2027-03-30", "Spring Break"],
  ["2027-03-31", "Spring Break"],
  ["2027-04-01", "Spring Break"],
  ["2027-04-02", "Spring Break"],
  ["2027-05-31", "Memorial Day"],
]);

export function getNoSchoolReason(dateStr: string): string | null {
  return NO_SCHOOL_DATES.get(dateStr) ?? null;
}

export function isNoSchoolDay(dateStr: string): boolean {
  return NO_SCHOOL_DATES.has(dateStr);
}

const PILOT_TIMEZONE = "America/Los_Angeles";

export function todayInTimezone(timezone: string = PILOT_TIMEZONE): string {
  // Dev/test override: ?testDate=YYYY-MM-DD forces a specific "today" so
  // tests can exercise phase-aware hero (Saturday check-in, Sunday confirm,
  // weekday Today/Upcoming). Read once per call (not cached) so changing
  // the URL param mid-session picks up immediately.
  if (typeof window !== "undefined" && import.meta.env.DEV) {
    const params = new URLSearchParams(window.location.search);
    const testDate = params.get("testDate");
    if (testDate && /^\d{4}-\d{2}-\d{2}$/.test(testDate)) return testDate;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Format an arbitrary Date as YYYY-MM-DD in the pilot timezone.
// Use this instead of date.toISOString().slice(0, 10) which converts to UTC
// and shifts the date by up to a day for SF users (UTC-7/-8).
export function dateInTimezone(date: Date, timezone: string = PILOT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export { PILOT_TIMEZONE };

// ── Drive status time gate ────────────────────────────────────
// The "I'm on my way" / "Ready" buttons are only active within a window
// around the meeting time. STATUS_WINDOW_BEFORE_MINUTES is set to 40 so the
// button appears ~40 min before pickup — tight enough to be actionable,
// wide enough to accommodate early prep.
export const STATUS_WINDOW_BEFORE_MINUTES = 40;
export const STATUS_WINDOW_AFTER_MINUTES = 30;

// Build a Date for a trip's meeting time in the pilot timezone.
// serviceDate is "YYYY-MM-DD"; meetingTime is "HH:MM:SS" or "HH:MM".
export function meetingDatetimeForTrip(
  serviceDate: string,
  meetingTime: string,
  timezone: string = PILOT_TIMEZONE,
): Date {
  const [h, m] = meetingTime.split(":");
  const [y, mo, d] = serviceDate.split("-").map(Number);
  // Parse the wall time as UTC (not local machine time)
  const wallAsUtc = Date.UTC(y, mo - 1, d, parseInt(h, 10), parseInt(m, 10), 0);
  // Get the Pacific offset at that instant
  const tzInfo = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(wallAsUtc));
  const offsetPart = tzInfo.find(p => p.type === "timeZoneName")?.value ?? "-07:00";
  const offsetMatch = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  let offsetHours = 0, offsetMinutes = 0;
  if (offsetMatch) {
    offsetHours = parseInt(offsetMatch[2], 10);
    offsetMinutes = offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0;
  }
  const sign = offsetMatch?.[1] === "+" ? 1 : -1;
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  // UTC = wall_time - offset (Pacific is -7, so UTC = wall + 7h)
  return new Date(wallAsUtc - offsetMs);
}

export function isWithinStatusWindow(
  serviceDate: string,
  meetingTime: string,
  timezone: string = PILOT_TIMEZONE,
  now: Date = new Date(),
): boolean {
  const meeting = meetingDatetimeForTrip(serviceDate, meetingTime, timezone);
  const opens = new Date(meeting.getTime() - STATUS_WINDOW_BEFORE_MINUTES * 60 * 1000);
  const closes = new Date(meeting.getTime() + STATUS_WINDOW_AFTER_MINUTES * 60 * 1000);
  return now >= opens && now <= closes;
}