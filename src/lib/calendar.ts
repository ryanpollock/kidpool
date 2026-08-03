import type { MyDriverAssignment } from "./supabase/carpool-repository";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIcsLocal(dateStr: string, timeStr: string): string {
  return `${dateStr.replaceAll("-", "")}T${timeStr.replaceAll(":", "")}00`;
}

function toGoogleDate(dateStr: string, timeStr: string): string {
  const date = new Date(`${dateStr}T${timeStr}:00`);
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}${m}${d}T${h}${min}00`;
}

function toOutlookDate(dateStr: string, timeStr: string): string {
  return `${dateStr}T${timeStr}:00`;
}

function eventSummary(assignment: MyDriverAssignment): string {
  const dir = assignment.trip.direction === "morning" ? "Morning" : "Afternoon";
  return `Carpool Crew: ${dir} drive to ${assignment.trip.destination}`;
}

function eventDescription(assignment: MyDriverAssignment): string {
  const riders = assignment.children.length > 0
    ? assignment.children.map((c) => `${c.first_name} ${c.last_name}`).join(", ")
    : "No riders assigned";
  return `Riders: ${riders}\\nVehicle: ${assignment.vehicle.label}\\nMeet at ${assignment.trip.meeting_time} at ${assignment.trip.origin}`;
}

function eventLocation(assignment: MyDriverAssignment): string {
  return assignment.trip.origin;
}

export function buildIcsEvent(assignment: MyDriverAssignment, timezone: string): string {
  const dtstart = toIcsLocal(assignment.trip.service_date, assignment.trip.meeting_time);
  const dtend = toIcsLocal(assignment.trip.service_date, assignment.trip.departure_time);
  const summary = eventSummary(assignment);
  const description = eventDescription(assignment);
  const location = eventLocation(assignment);
  const uid = `${assignment.assignment.id}@carpoolcrew.co`;
  const dtstamp = toIcsLocal(new Date().toISOString().slice(0, 10), new Date().toTimeString().slice(0, 5));
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${timezone}:${dtstart}`,
    `DTEND;TZID=${timezone}:${dtend}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    "END:VEVENT",
  ].join("\r\n");
}

export function buildIcsCalendar(assignments: MyDriverAssignment[], timezone: string): string {
  const events = assignments.map((a) => buildIcsEvent(a, timezone)).join("\r\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Carpool Crew//EN",
    `X-WR-TIMEZONE:${timezone}`,
    events,
    "END:VCALENDAR",
  ].join("\r\n");
}

export function buildGoogleCalendarUrl(assignment: MyDriverAssignment, timezone: string): string {
  const start = toGoogleDate(assignment.trip.service_date, assignment.trip.meeting_time);
  const end = toGoogleDate(assignment.trip.service_date, assignment.trip.departure_time);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: eventSummary(assignment),
    dates: `${start}/${end}`,
    ctz: timezone,
    location: eventLocation(assignment),
    details: eventDescription(assignment).replaceAll("\\n", "\n"),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildOutlookUrl(assignment: MyDriverAssignment, _timezone: string): string {
  const start = toOutlookDate(assignment.trip.service_date, assignment.trip.meeting_time);
  const end = toOutlookDate(assignment.trip.service_date, assignment.trip.departure_time);
  const params = new URLSearchParams({
    subject: eventSummary(assignment),
    startdt: start,
    enddt: end,
    location: eventLocation(assignment),
    body: eventDescription(assignment).replaceAll("\\n", "\n"),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function downloadIcs(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}