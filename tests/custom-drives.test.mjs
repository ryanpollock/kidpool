// Static contract checks for the ad hoc custom drives feature.
//
// Custom drives are trips with slot='custom' and an arbitrary meeting_time,
// created mid-week by any parent with a vehicle against the current
// published schedule version. These checks pin the schema migration, the
// four security-definer RPCs, the reminder-cron widening, the scheduler's
// exclusion + carry-over, the send-push rework, and the UI wiring — the
// chat.test.mjs conventions applied to a feature-specific file.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const customDrivesMigrationUrl = new URL(
  "../supabase/migrations/202609100002_custom_drives.sql",
  import.meta.url,
);
const reminderCronMigrationUrl = new URL(
  "../supabase/migrations/202609100003_custom_drive_reminder_cron.sql",
  import.meta.url,
);
const typesUrl = new URL("../src/lib/supabase/database.types.ts", import.meta.url);
const repoUrl = new URL("../src/lib/supabase/carpool-repository.ts", import.meta.url);
const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const prototypeCssUrl = new URL("../src/prototype.css", import.meta.url);
const sendPushUrl = new URL("../supabase/functions/send-push/index.ts", import.meta.url);
const generateScheduleUrl = new URL("../supabase/functions/generate-schedule/index.ts", import.meta.url);

const customDriveRpcs = [
  {
    fn: "offer_custom_drive",
    grant: "uuid, date, public.trip_direction, time, uuid[]",
  },
  { fn: "join_custom_drive", grant: "uuid, uuid[]" },
  { fn: "leave_custom_drive", grant: "uuid, uuid" },
  { fn: "cancel_custom_drive", grant: "uuid" },
];

test("custom drives migration widens the slot CHECK and the unique constraint", async () => {
  const sql = await readFile(customDrivesMigrationUrl, "utf8");

  // 'custom' admitted as a slot value
  assert.match(
    sql,
    /check \(slot in \('am', 'pm_early', 'pm_late', 'custom'\)\)/,
    "trips_slot_check must admit 'custom'",
  );

  // The (week_id, service_date, slot) unique constraint is replaced by a
  // partial unique index covering standard slots only — multiple custom
  // drives may exist on the same day.
  assert.match(sql, /drop constraint trips_week_id_service_date_slot_key/);
  assert.match(
    sql,
    /create unique index trips_week_date_standard_slot_key\s+on public\.trips \(week_id, service_date, slot\)\s+where slot <> 'custom'/,
    "standard-slot uniqueness must survive as a partial unique index",
  );
});

test("custom drive RPCs follow the security-definer conventions", async () => {
  const sql = await readFile(customDrivesMigrationUrl, "utf8");

  for (const { fn, grant } of customDriveRpcs) {
    assert.match(
      sql,
      new RegExp(`create or replace function public\\.${fn}\\b`),
      `missing RPC ${fn}`,
    );
    assert.match(
      sql,
      new RegExp(`security definer`, "i"),
      `${fn} must be security definer`,
    );
    assert.match(
      sql,
      new RegExp(`set search_path = public, extensions`, "i"),
      `${fn} must pin search_path`,
    );
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${fn}\\(${grant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) from public`),
      `${fn} must be revoked from public`,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${fn}\\(${grant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) to authenticated`),
      `${fn} must be granted to authenticated`,
    );
  }

  // Auth + audit conventions shared by every mutation RPC in the repo
  const authGuards = sql.match(/if auth\.uid\(\) is null then/g);
  assert.ok(authGuards && authGuards.length >= 4, "every RPC needs an auth guard");
  const auditInserts = sql.match(/insert into public\.audit_events/g);
  assert.ok(auditInserts && auditInserts.length >= 4, "every RPC needs an audit event");
  for (const action of [
    "custom_drive_offered",
    "custom_drive_joined",
    "custom_drive_left",
    "custom_drive_cancelled",
  ]) {
    assert.match(sql, new RegExp(`'${action}'`), `missing audit action ${action}`);
  }
});

test("custom drive RPC invariants: published version, future guard, capacity, vehicle", async () => {
  const sql = await readFile(customDrivesMigrationUrl, "utf8");

  // Version resolution is shared with the app's roster display: published
  // first, else the latest draft (202609130001 added the pre-publish path).
  const publishedGuards = sql.match(/status = 'published'/g);
  assert.ok(publishedGuards && publishedGuards.length >= 1, "the RPCs must resolve a published version when one exists");

  // Future-trip guard (pilot timezone) — same pattern as the reassignment RPC
  const futureGuards = sql.match(/at time zone v_group\.timezone <= now\(\)/g);
  assert.ok(futureGuards && futureGuards.length >= 4, "every RPC needs the future-trip guard");

  // join_custom_drive enforces remaining seats
  assert.match(sql, /child_passenger_capacity - v_current_riders/);
  assert.match(sql, /Only % seat% left on this drive/);

  // offer_custom_drive vehicle rule mirrors resolveDriverVehicle
  assert.match(
    sql,
    /order by coalesce\(default_driver_id = auth\.uid\(\), false\) desc,\s*child_passenger_capacity asc, label asc/,
  );

  // cancel deletes the trip (FK cascades clean rosters) and returns the
  // pre-cancel snapshot for notifications
  assert.match(sql, /delete from public\.trips where id = p_trip_id/);
  assert.match(sql, /rider_profile_ids/);
});

test("reminder cron widened to */5 so custom times get reminders", async () => {
  const sql = await readFile(reminderCronMigrationUrl, "utf8");

  assert.match(sql, /cron\.unschedule\('drive-reminder'\)/);
  assert.match(sql, /cron\.unschedule\('status-reminder'\)/);
  assert.match(sql, /'\*\/5 \* \* \* \*'/);
  assert.match(sql, /send_drive_reminders\(\)/);
  assert.match(sql, /send_status_reminders\(\)/);
});

test("database types: TripSlot includes 'custom' and the four RPCs are typed", async () => {
  const types = await readFile(typesUrl, "utf8");
  assert.match(
    types,
    /export type TripSlot = "am" \| "pm_early" \| "pm_late" \| "custom";/,
  );
  for (const fn of customDriveRpcs.map((r) => r.fn)) {
    assert.match(types, new RegExp(`\\b${fn}: \\{`), `missing Database type for ${fn}`);
  }
});

test("repository: custom drive methods, notification types, time-aware sort", async () => {
  const repo = await readFile(repoUrl, "utf8");

  for (const fn of customDriveRpcs.map((r) => r.fn)) {
    assert.match(repo, new RegExp(`"${fn}"`), `repository must call RPC ${fn}`);
  }
  assert.match(repo, /offerCustomDrive\(/);
  assert.match(repo, /joinCustomDrive\(/);
  assert.match(repo, /leaveCustomDrive\(/);
  assert.match(repo, /cancelCustomDrive\(/);

  // sendCustomDriveNotification covers all four lifecycle notifications
  assert.match(
    repo,
    /"custom_drive_offered" \| "custom_drive_joined" \| "custom_drive_left" \| "custom_drive_cancelled"/,
  );

  // Display sort is time-aware (direction first, then meeting_time) so a
  // 4:50 PM custom drive no longer clumps with pm_late
  assert.match(repo, /trip\.direction === "morning" \? "0" : "1"\}\|\$\{trip\.meeting_time/);
});

test("generate-schedule excludes custom trips from the algorithm and carries them over", async () => {
  const source = await readFile(generateScheduleUrl, "utf8");

  // Exclusion before feeding the algorithm
  assert.match(source, /t\.slot !== "custom"/);

  // Carry-over of custom assignments from prior versions into the new one
  assert.match(source, /customTripIds/);
  assert.match(source, /Carry over ad hoc custom drives/i);

  // Displaced-driver detection must ignore custom drives
  assert.match(source, /customTripIdSet\.has\(a\.trip_id\)/);
});

test("send-push: reminder windows process ALL matching trips, direction-derived labels", async () => {
  const source = await readFile(sendPushUrl, "utf8");

  // Window matching collects every trip whose reminder minute matches now
  const matchingFilters = source.match(/const matchingTrips = todayTrips\.filter\(\(t: any\) =>/g);
  assert.ok(matchingFilters && matchingFilters.length === 2, "drive_reminder + status_reminder both need the all-matching filter");

  // The old break-on-first-match + slot-derived period must be gone
  assert.doesNotMatch(source, /slot = t\.slot;/);
  assert.doesNotMatch(source, /const period = slot === "am" \? "morning" : "afternoon";/);
  assert.doesNotMatch(source, /const isMorning = slot === "am";/);

  // Direction-derived labels (the isMorning variable name is load-bearing
  // for the rider-parent gating)
  assert.match(source, /const isMorning = trip\.direction === "morning";/);
});

test("send-push: backpack sheet + night-before render custom drives", async () => {
  const source = await readFile(sendPushUrl, "utf8");

  // Backpack sheet child info is trip-keyed (slot-keyed entries collided
  // for two customs on one day)
  assert.match(source, /info\.set\(trip\.id, entry\)/);
  assert.doesNotMatch(source, /info\[slotKey\] = entry/);
  assert.match(source, /\(extra drive\)/);

  // Night-before roster sorts chronologically and labels customs
  assert.match(source, /String\(a\.meeting_time\)\.localeCompare\(String\(b\.meeting_time\)\)/);
  assert.match(source, /trip\.slot === "custom"/);

  // Roster email bodies render formatted times, not raw "17:15:00"
  assert.match(source, /Trip: \$\{formatTime\(trip\.meeting_time\)\}/);
});

test("send-push: four custom-drive notification types with idempotent tags", async () => {
  const source = await readFile(sendPushUrl, "utf8");

  for (const t of [
    "custom_drive_offered",
    "custom_drive_joined",
    "custom_drive_left",
    "custom_drive_cancelled",
  ]) {
    assert.match(source, new RegExp(`type === "${t}"`), `missing branch ${t}`);
  }
  assert.match(source, /`custom-drive-offered-\$\{trip_id\}`/);
  assert.match(source, /`custom-drive-joined-/);
  assert.match(source, /`custom-drive-left-/);
  assert.match(source, /custom-drive-cancelled-/);
});

test("UI: offer/join/cancel wiring and the Extra drive chip", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  // Offer sheet + Home entry point
  assert.match(source, /function OfferCustomDriveSheet\(/);
  assert.match(source, /data-testid="offer-custom-drive"/);
  assert.match(source, /data-testid="offer-time-input"/);
  assert.match(source, /data-testid="offer-submit"/);
  assert.match(source, /repository\.offerCustomDrive\(/);
  assert.match(source, /"custom_drive_offered", assignment\.trip_id/);

  // Join / cancel / overlap flows
  assert.match(source, /data-testid="custom-join-block"/);
  assert.match(source, /repository\.joinCustomDrive\(/);
  assert.match(source, /data-testid="cancel-custom-drive"/);
  assert.match(source, /repository\.cancelCustomDrive\(/);
  assert.match(source, /data-testid="overlap-cancel-ride"/);

  // Extra drive chip never lets a custom drive look like a standard one
  assert.match(source, /isCustomDrive && <span className="extra-drive-chip">Extra drive<\/span>/);
  assert.match(source, /extra-drive-chip--header/);

  // Sibling afternoon switch only exists for the standard slots
  assert.match(
    source,
    /found\.trip\.slot === "pm_early" \|\| found\.trip\.slot === "pm_late"/,
  );

  // Time-aware display sort + DriveCard afternoon headline carries the time
  assert.match(source, /a\.meeting_time\.localeCompare\(b\.meeting_time\)/);
  assert.match(source, /\? "Morning"\s+: `Afternoon · \$\{formatMeetingTime\(trip\.meeting_time\)\}`/);
});

test("prototype.css: custom drive styles exist and respect the 16px input rule", async () => {
  const css = await readFile(prototypeCssUrl, "utf8");
  for (const cls of [".extra-drive-chip", ".offer-chip", ".custom-join-block", ".custom-cancel-block"]) {
    assert.match(css, new RegExp(cls.replace(".", "\\.") + "\\s*\\{"), `missing ${cls} style`);
  }
  // The font-size contract: any input/textarea rule must be >= 16px
  for (const rule of css.match(/[^{}]+\{[^}]*\}/g) ?? []) {
    const selector = rule.split("{")[0].trim();
    if (/(\binput\b|textarea)/.test(selector)) {
      const fs = rule.match(/font-size:\s*([\d.]+)px/);
      if (fs) assert.ok(parseFloat(fs[1]) >= 16, `${selector} input font-size must be >= 16px`);
    }
  }
});
// ── Published-only offers (202609270001) + rider coverage (202609270002) ──
//
// Decision 2026-09-26/27 reverses, for OFFERS only, the Sep 13
// any-juncture relaxation: offers require the week's PUBLISHED schedule,
// and a child seated on an extra drive counts as covered everywhere a
// child can be placed onto a standard-trip car.

const anyJunctureMigrationUrl = new URL(
  "../supabase/migrations/202609130001_custom_drives_any_juncture.sql",
  import.meta.url,
);
const offersRequirePublishedUrl = new URL(
  "../supabase/migrations/202609270001_custom_drive_offers_require_published.sql",
  import.meta.url,
);
const riderCoverageMigrationUrl = new URL(
  "../supabase/migrations/202609270002_custom_drive_rider_coverage.sql",
  import.meta.url,
);

test("custom drives resolve the version the roster displays: published → latest draft (join/leave/cancel)", async () => {
  const sql = await readFile(anyJunctureMigrationUrl, "utf8");

  // Shared resolver, still used by join/leave/cancel (offer no longer uses it)
  assert.match(sql, /create or replace function public\.resolve_custom_drive_version\(/);
  assert.match(sql, /revoke all on function public\.resolve_custom_drive_version\(uuid, uuid\) from public;/);
  // Published wins; otherwise the latest version_number
  const resolver = sql.split(/create or replace function public\.resolve_custom_drive_version/)[1].split("$$;")[0];
  assert.match(resolver, /status = 'published'/);
  assert.match(resolver, /order by version_number desc/);

  // join/leave/cancel guard the no-version case
  const noVersionGuards = sql.match(/No schedule version exists for this week yet/g);
  assert.ok(noVersionGuards && noVersionGuards.length === 3, "join/leave/cancel must guard the no-version case");
});

test("offer_custom_drive requires the week's published schedule (no v1 seeding)", async () => {
  const sql = await readFile(offersRequirePublishedUrl, "utf8");

  // Guard restored from 202609100002: no published version → raise
  assert.match(sql, /status = 'published'/);
  assert.match(sql, /The schedule for that week is not published yet/, "offer must raise the published-only guard");
  assert.match(sql, /revoke all on function public\.offer_custom_drive\(uuid, date, public\.trip_direction, time, uuid\[\]\) from public;/);
  assert.match(sql, /grant execute on function public\.offer_custom_drive\(uuid, date, public\.trip_direction, time, uuid\[\]\) to authenticated;/);

  // The manual-v1 seed is gone — offers never fabricate a draft version
  assert.doesNotMatch(sql, /insert into public\.schedule_versions/);
  assert.doesNotMatch(sql, /created_schedule_version/);
  assert.doesNotMatch(sql, /resolve_custom_drive_version/, "offer must not fall back to a draft version");
});

test("custom-drive seats count as coverage everywhere (rider coverage migration)", async () => {
  const sql = await readFile(riderCoverageMigrationUrl, "utf8");

  // Offer + join reject a child already on another extra drive that day
  const doubleCustomGuards = sql.match(/That child is already on another extra drive that day/g);
  assert.ok(doubleCustomGuards && doubleCustomGuards.length === 2, "offer and join must reject double extra-drive seats");

  // Volunteer (own children + other children) and manually_assign_driver
  // credit custom-seat coverage for any preference
  const customCreditClauses = sql.match(/ct\.slot = 'custom'/g);
  assert.ok(customCreditClauses && customCreditClauses.length === 3, "volunteer ×2 and manually_assign ×1 must credit custom seats");

  // Version-scoped child checks use the date+direction rule — a custom seat
  // covers every standard trip of that date+direction
  assert.match(sql, /ct\.service_date = v_trip\.service_date/);
  assert.match(sql, /ct\.direction = v_trip\.direction/);

  // Volunteer rejects a driver with a custom assignment at the identical
  // date+time (same physical drive)
  const driverTimeGuard = sql.match(/\bt\.slot = 'custom'/g);
  assert.ok(driverTimeGuard && driverTimeGuard.length === 1, "volunteer must reject a same-time custom driver");
  assert.match(sql, /You are already driving at that time/);
});

test("generate-schedule filters custom-covered riders and same-time custom drivers", async () => {
  const source = await readFile(generateScheduleUrl, "utf8");

  // Custom rider coverage set + driver-busy set are built from the same
  // rows the carry-over copies (newest active DA per custom trip)
  assert.match(source, /customCoveredChildKeys\.add\(`\$\{trip\.service_date\}\|\$\{trip\.direction\}\|\$\{childId\}`\)/);
  assert.match(source, /customDriverBusyKeys\.add\(`\$\{da\.driver_profile_id\}\|\$\{trip\.service_date\}\|\$\{trip\.meeting_time\}`\)/);
  assert.match(source, /return !customCoveredChildKeys\.has\(`\$\{trip\.service_date\}\|\$\{trip\.direction\}\|\$\{r\.child_id\}`\)/);
  assert.match(source, /return !customDriverBusyKeys\.has\(`\$\{a\.driver_profile_id\}\|\$\{trip\.service_date\}\|\$\{trip\.meeting_time\}`\)/);
});

test("repository loaders credit custom-drive seats as coverage (all three)", async () => {
  const source = await readFile(repoUrl, "utf8");

  // getUncoveredChildren + the draft loader + the published loader all
  // key coverage by date+direction and treat 'custom' as coverage
  const customCredit = source.match(/coveredSlots\.has\("custom"\)/g);
  assert.ok(customCredit && customCredit.length === 3, "all three coverage computations must credit custom seats");
  const directionKeys = source.match(/const key = `\$\{trip\.service_date\}\|\$\{trip\.direction\}\|\$\{ra\.child_id\}`/g);
  assert.ok(directionKeys && directionKeys.length === 3, "covered-slot maps must be date+direction scoped");
});

test("send-push uncovered/admin-escalation converge on the same coverage semantics", async () => {
  const source = await readFile(sendPushUrl, "utf8");

  assert.match(source, /async function uncoveredChildrenForVersion\(/);
  // Custom seats cover same date+direction; either-sibling dedup preserved
  assert.match(source, /customCovered\.add\(`\$\{trip\.service_date\}\|\$\{trip\.direction\}\|\$\{r\.child_id\}`\)/);
  assert.match(source, /slots\.has\(siblingSlot\)/);
  // Both branches route through the shared computation
  const calls = source.match(/uncoveredChildrenForVersion\(version_id\)/g);
  assert.ok(calls && calls.length === 2, "uncovered + admin_escalation branches must both use the shared helper");
});

test("UI: the offer button is visible-but-disabled until the schedule is published", async () => {
  const source = await readFile(prototypeUrl, "utf8");
  const css = await readFile(prototypeCssUrl, "utf8");

  // Offers open the sheet only post-publish; pre-publish renders a
  // disabled entry point with an explainer (never a disappearing button)
  assert.match(source, /data-testid="offer-custom-drive"/);
  assert.match(source, /data-testid="offer-custom-drive-locked"/);
  assert.match(source, /Opens Sunday evening, once the weekly schedule is published/);

  // Disabled entry styling exists
  assert.match(css, /\.coverage-alert:disabled\s*\{/);

  // The Today card credits extra-drive seats on standard legs
  assert.match(source, /today-card-ride--covered/);
  assert.match(css, /\.today-card-ride--covered\s*\{/);
  assert.match(source, /Riding the \{formatMeetingTime\(coveringCustomTrip\.meeting_time\)\} extra drive/);

  // This Week renders legs chronologically (morning first, then pickup time)
  assert.match(source, /dateTrips\.sort\(tripSlotSort\)/);

  // The sheet's pre-publish copy is gone (it can no longer open pre-publish);
// the remaining schedulePublished wiring belongs to the HomeScreen hero card
  assert.doesNotMatch(source, /the drive goes live with the week's published schedule \(Sun 7 PM\)/);
  assert.doesNotMatch(source, /schedulePublished=\{homeSchedule\?\.version\.status === "published"\}\s*\n\s*onSubmit=\{offerCustomDrive\}/);
});
