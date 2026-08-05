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
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export { PILOT_TIMEZONE };