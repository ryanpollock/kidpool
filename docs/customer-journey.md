# Customer Journey — Pilot Test Week

**Audience:** Ryan (PM + coordinator) and engineering
**Purpose:** Screen-by-screen walkthrough of what the 5 pilot families will experience during the test week (Aug 10–14), what works, what's confusing, what's broken, and what's missing. This is the PM artifact we review together before locking in the fix plan.

**Pilot group as of Aug 5:**

| Household | Adults | Children | Vehicle |
|---|---|---|---|
| Pollock (coordinator) | Ryan + Allison | Sara (priority) | Gray Honda, 4 seats |
| Yu-fam | Tiffany | Elinore | Gray Kia, 4 seats |
| Miyano-Bellet | Laura | Hideo | Black Toyota, 4 seats |
| Ou Mikecz | Yvonne + Justin | Enzo, Zadie Rose | Blue Mach-E/Prius, 4 seats |
| Visses | Junko | Emi | Silver Mazda CX-5, 4 seats |

6 children, 20 seats of capacity, 5 driving households.

---

## 1. Sign-in

**What the user sees:** "Carpool Crew" logo, "Continue with Google" button, a short trust list ("Only basic profile info", "No tracking", "Signed-out visitors see nothing"), and a footnote about pilot privacy.

**What works:** Google OAuth via `signInWithOAuth({ provider: "google" })`. On success, the app loads identity and routes to onboarding (no household) or Home (has household).

**Issues:**
- **Post-OAuth redirect lands on `kidpool-sf.vercel.app`**, not `carpoolcrew.co`. The Supabase auth `site_url` is set to the kidpool-sf subdomain. A parent who signs in at carpoolcrew.co may see the URL bar flip to the old name mid-flow. Cosmetic but brand-breaking.
- **No error recovery if OAuth fails.** A failed OAuth redirects back to the sign-in screen with no error message — the parent just sees the same screen again and may think the app is broken.

---

## 2. Onboarding (first run only)

**What the user sees:** A 4-step wizard — `household → children → vehicle → standard_week`.

- **Step 1 (household):** Full name + phone. Validation: name ≥2 words, phone ≥7 digits. Choose Create or Join. Creating a household shows a list of existing household names and warns on a likely duplicate. Creating returns a 10-char join code.
- **Step 2 (children):** First name, last name. Can add multiple.
- **Step 3 (vehicle):** Label (e.g. "Gray Honda"), child-passenger capacity (1–12).
- **Step 4 (standard_week):** Default ride needs per child per weekday/direction, and default driving preferences (prefer/can/cannot).

**What works:** The full wizard completes and writes to all the right tables. Joining a household via code works — Ou Mikecz has two adults (Yvonne + Justin) who joined independently, proving the multi-adult path. Default ride needs and drive preferences are applied to future check-ins, so the standard-week prefill works.

**Issues:**
- **Phone is required** (≥7 digits validation). The PRD §4 says don't collect a child's phone, but an *adult* phone is reasonable for the parent directory. However, there's no skip option — a parent who doesn't want to share a phone is forced to enter one. Allison Pollock has `phone: null` so somehow got through, but the validation suggests it should be required. Inconsistent.
- **No "what is this for?" framing on the join code.** A co-parent who signs up independently sees the join code field but no explanation of what a household code is or where to get it. The parent-pilot email mentions it, but the in-app flow doesn't.
- **Standard-week step is dense.** 5 days × 2 directions × per-child ride toggles + per-trip driving preference is a lot for a first-time user. No "skip for now" — the defaults are blank, which means the first real check-in will start empty rather than prefilled. (The prefill happens via `loadCheckin` applying defaults on first open, so this is fine in practice, but the standard-week screen feels like busywork during onboarding.)

---

## 3. Next Week tab — Saturday check-in

**What the user sees:** Week of Aug 10 header. Each weekday shows a morning card and an afternoon card. Each card has:
- "Rides needed" — child pills (Sara, Elinore, etc.) that toggle on/off
- "Your driving" — Prefer / Can / Can't segmented control

A "Submit my week" button at the bottom. After submit, "Reopen my check-in".

**What works:** The real-time co-parent sync is the best feature here — when one adult edits, the other sees "Updated just now" within seconds. The prefilled defaults from the standard-week mean a parent who has no changes can just tap "Submit my week" and be done. The Prefer/Can/Can't control requires an active vehicle (set in onboarding), which correctly prevents a parent from offering to drive without a car.

**Issues:**
- **`max_drives` is invisible.** The PRD lists "max drives" as a check-in field. The column exists (`weekly_checkins.max_drives`), the repo defaults it to 10, and Ryan's test data shows he set it to 7 for Aug 10. But the Plan tab never shows or edits it. A parent has no way to say "I'll only drive twice this week." For the test week with 5 trips, the default 10 is fine, but this is a half-built feature.
- **No "Confirm week" single action.** The PRD §5 says "The default response should be a single Confirm week action when nothing has changed." The app doesn't have this — the prefilled form *is* the starting point, but the parent still has to scroll to the bottom and tap "Submit my week." Reasonable, but not the one-tap ideal the PRD describes.
- **No explicit "I'm out this week" absence.** A parent who can't participate at all has to toggle every trip to Can't and uncheck every ride. There's no "We're away this week" shortcut.
- **Deadline displayed in UTC.** The check-in deadline for Aug 10 is stored as `2026-08-08 15:00:00+00` (3 PM UTC = 8 AM Pacific). If the deadline were shown on this screen it would say "8:00 AM" — confusing. (It's shown on the Home screen, not here, but the same bug applies.)
- **Vehicle is read-only.** The Plan tab shows the household's active vehicle as a summary line ("Gray Honda · 4 seats"). If a parent wants to use a different car for a specific trip, they have to go to Account, change the vehicle, come back, set the preference, then change it back. No per-trip vehicle picker.
- **Lock states are clear but unforgiving.** Once the week is published or started, the check-in locks with a banner. There's no "request a change" path from the locked screen — the parent has to contact the coordinator out of band.

---

## 4. Home tab — Sunday confirmation

**What the user sees (when they have tentative assignments):** A dominant hero card:
- Eyebrow: "Action needed"
- H1: "Confirm your drives"
- Deadline: "2 assignments · Confirm by [deadlineLabel]"
- Subtext: "These are tentative until you accept them. Opening this schedule does not count as confirmation."

Below the hero: the assignment list, each row showing trip, vehicle, rider count, and a status pill (teal for tentative, green for confirmed, red for declined/expired). Tentative state shows "Confirm all drives" (opens a dialog listing all tentative trips) and "Review individually" (opens the Review screen).

**What works:** The confirmation hero is genuinely dominant — it's the first thing below the header and push banners. The anti-inference copy ("Opening this schedule does not count as confirmation") directly addresses the PRD's hardest rule. `respondToDriverAssignment` is the only path to `confirmed`, so the app does not silently infer confirmation. "Confirm all drives" opens a dialog that lists every tentative trip with vehicle + rider count, so the parent sees exactly what they're committing to before tapping "Yes, confirm all." Confirmed assignments get a "Can't make this drive" link with a confirm step ("Cancel this drive? Affected families will be notified immediately.").

**Issues:**
- **Deadline displayed in UTC.** `confirmationDeadline` is rendered via `new Date(confirmationDeadline).toLocaleString(...)`. For Aug 10's week, `confirmation_deadline` is `2026-08-09 15:00:00+00` (3 PM UTC = 8 AM Pacific). The hero will say "Confirm by Sun 8:00 AM" instead of "Sun 3:00 PM." This will confuse every family on Sunday morning. The app doesn't enforce the deadline (it locks on publish instead), so it's cosmetic but high-visibility.
- **No real-time updates.** If Ryan publishes the schedule while a parent is looking at Home, the parent won't see "Published schedule" until they pull-to-refresh or switch tabs. The parent could be staring at "Action needed" for a schedule that's already live.
- **Push banners sit above the hero.** The "Get notified" push-permission banner and the iOS "Add to Home Screen" banner render *above* the confirmation hero. For a first-time user on Sunday morning, the push banner competes with the confirmation request for attention. The PRD/AGENTS says the confirmation request "must dominate the home screen until explicitly resolved" — the push banner doesn't strictly violate this (the hero is still prominent), but it dilutes it.
- **Uncovered alerts have no action.** When a trip is uncovered (no driver), the alert lists the trip and the affected children but offers only "Contact the admin or check the full schedule." There's no "I can drive this trip" button — that button only appears for *declined* drives (where a driver was assigned then backed out). A child whose trip never got a driver has no quick-cover path from Home. For the test week, if the scheduler can't cover a trip, the affected parent can only wait for Ryan to resolve it.

---

## 5. This Week tab — published roster

**What the user sees:** Mon–Fri grid, AM/PM rows. Each trip is a card showing:
- Coverage state (if no drivers: "No drivers" alert; else "N cars" badge)
- Drive cards: driver name, vehicle label + seat count, child chips with first names
- Declined/released drivers shown with line-through and a label
- Uncovered riders shown as amber chips with names
- A status strip at top: "X covered, Y need rides, Z declined"

Tapping a drive card opens `DriveDetailScreen` with time, route, driver, vehicle, and a child photo grid.

**What works:** The Mon–Fri grid with no-school days (Aug 17 for the following week) renders correctly. Uncovered riders are shown by name — the app does not hide deficits. The coverage strip gives a quick summary. Declined drivers are visually distinct (line-through).

**Issues — this is the biggest problem area:**
- **Tentative and confirmed drivers are visually interchangeable.** `activeRosters` includes both `tentative` and `confirmed` drivers (`Prototype.tsx:2202-2204`), and the drive cards render them identically — same driver name, same vehicle, same child chips, same "N cars" badge, **no status pill**. `DriveDetailScreen` likewise shows no status. A family viewing the published roster cannot tell whether their driver has actually confirmed. The PRD/AGENTS explicitly says "offered, tentative, confirmed, and uncovered states must never be visually interchangeable." This is the clearest PRD violation in the app and the most important fix for the test week.
- **No draft preview.** The This Week tab only shows the latest *published* version (`publishedSchedule`). Drafts are invisible to families — they only see draft state on the Home tab's confirmation hero (for their own tentative assignments). A coordinator cannot share a draft with families for review before publishing.
- **No change history.** The repo writes `audit_events` for every schedule change, but the UI never reads them. A family can't see "what changed since the last version."
- **No real-time updates.** If Ryan publishes while a parent is looking at This Week, the parent won't see the new roster until they pull-to-refresh or switch tabs.

---

## 6. Status tab — coordinator (Ryan only)

**What the user sees:** "Admin view" eyebrow, "Weekly coverage" H1, week label. Then:
- Coverage summary: Submitted / In progress / Not started household counts
- Declined-drive alert (count + "If no one steps up, regenerate the draft to reassign")
- Uncovered-trip alert (count + "Review the trip demand below before publishing")
- Generate / Publish / Regenerate buttons (see below)
- Household responses list (submitted / in progress / not started chips per household)
- Trip demand table (per trip: riders, seats, Covered / Short / No riders; uncovered children listed by first name when short)

**What works:** The generate → publish → regenerate flow is correct and safe. Publish is blocked when `uncoveredCount > 0` (button says "Resolve uncovered first"). Regenerating a published week requires a confirmation dialog ("This will replace the published schedule. The new schedule goes live immediately. Continue?"). The trip demand table names uncovered children, so Ryan can see exactly who needs coverage.

**Issues:**
- **The tab is labeled "Status" in the nav but "Admin view" on the eyebrow.** OPS.md calls it "Cover tab." Three names, one tab. Pick one.
- **No week navigation.** The Status tab operates on `weekData` (the current week via `getCurrentWeek`). Today (Wed Aug 5) that's the Aug 3 week. On Saturday Aug 8 it becomes the Aug 10 week. Ryan cannot manage the Aug 10 week from the Status tab until Saturday — even though parents can check in for Aug 10 from the Next Week tab right now. This is intentional (the PRD's Saturday-generate cadence) but it means Ryan has to wait until Saturday to generate the test-week schedule. If he wanted to generate a draft on Friday to preview, he can't.
- **No manual override.** Ryan cannot assign a specific driver to a specific trip from the UI. The only lever is "Regenerate draft" which re-runs `greedy-v1` from scratch. If Ryan wants to manually put Justin on Tuesday morning, he has to do it via SQL. The PRD §12 lists "Override suggestions with a recorded reason" as a coordinator requirement — not implemented.
- **No version comparison.** The PRD §12 lists "Compare draft versions and see which assignments changed" — not implemented. Ryan can only see the latest version's coverage, not what changed between version 1 and version 2.
- **No member management.** Ryan can't add, remove, or suspend members from the UI. He can't assign coordinator role to another adult. All of this is SQL-only per the README. For the test week with 5 trusted families this is fine; for a real pilot it's a gap.
- **No open-drive board.** The PRD §5 describes an open-drive request flow where eligible adults receive a request and the first to claim it becomes the replacement. The app has the volunteer RPC (`volunteerForDeclinedDrive`) and the Home-screen "I can drive" button for declined drives, but there's no coordinator-facing board showing "these trips are open, these adults are eligible, send a request to X." Ryan can only wait for a parent to self-volunteer.
- **Coverage states don't distinguish "needs assignment" from "short seats".** The trip demand table shows "Covered" / "Short" / "No riders" but the PRD's five states (Covered / Needs assignment / Short seats / Changed / Canceled) are reduced to three in the UI. "Needs assignment" (enough seats exist but no driver assigned) is folded into "Short." This is a minor simplification but means Ryan can't tell "I need to find a driver" from "I need to find more seats."

---

## 7. Account screen (overlay, opened from header avatar)

**What the user sees:** Editable household name, adult profile (name, phone, sharing toggles), children list (with photo upload, buddy picker), vehicle editor, join code (with regenerate), standard-week defaults.

**What works:** Everything here is functional. Child photo upload works (Sara has a photo). The buddy picker lets a parent pick a child from *another* household as a preferred buddy. The join code can be regenerated with a confirmation dialog. Sharing toggles for phone/email control directory visibility.

**Issues:**
- **Buddy picker is one-directional.** A parent sets *their* child's buddy, but the other child's parent has to set it reciprocally for the buddy advantage to work both ways. The FAQ explains this, but the UI doesn't prompt or verify. Sara Pollock has a buddy set; the buddy's parent would need to set Sara back for the bidirectional advantage.
- **No priority indicator.** Sara is `is_priority` in the DB (set via SQL migration). The Account screen never shows this. A coordinator can't see or toggle priority from the UI — it's SQL-only. For the test week this is fine (Sara is already set), but if Ryan wants to mark another child priority, he has to run SQL.
- **Vehicle editor allows deactivation but not reactivation.** Yu-fam has an inactive vehicle (Teal VW). The UI lets you add a new vehicle but I didn't see a "reactivate" path — deactivated vehicles may be permanently gone from the UI's perspective. (Need to verify.)

---

## 8. Review screen (overlay, opened from Home "Review individually")

**What the user sees:** Per-assignment cards with trip, vehicle, rider count, and two actions: "I can make this one" (confirm) and "I can't make this one" (decline). Declining opens a form with a reason field ("Reason (optional)") and "Confirm decline."

**What works:** The per-assignment confirm/decline is clean. The decline reason is captured and stored. After declining, the assignment shows "Re-accept this drive" (leveraging the `202608020003_allow_rerespond` migration). The audit trail records who declined when.

**Issues:**
- **Re-accept has no guard.** The `202608020003` migration removed *all* status guards from `respond_to_driver_assignment`, not just the `tentative`-only check. A driver can re-respond to a `released` assignment (one that `volunteerForDeclinedDrive` already replaced and moved riders off of), resurrecting it as `confirmed` with zero riders. For the test week, this is unlikely to bite (no one will decline-then-reaccept a released drive), but it's a latent correctness bug.

---

## 9. Quick changes — what exists and what's missing

The PRD §6 lists five quick-change actions. Here's the state:

| PRD quick change | Implemented? | Where |
|---|---|---|
| "My child won't ride" (child absence) | **No** | No quick absence flow. The only way to remove a child from a trip is to un-toggle ride needs in the *next* week's check-in — not available mid-week for the current published week. |
| "I can drive this trip" | **Partial** | Only for *declined* drives that affect the user's own children (Home declined alert → "I can drive"). Not available for *uncovered* trips (no driver was ever assigned). |
| "I can't drive this trip" | **Yes** | Home confirmed assignment → "Can't make this drive" (with confirm step). Review screen → "I can't make this one" (with reason). |
| "My available seat count changed" | **No** | No quick seat-count change. Vehicle capacity is set only in Account/Onboarding. |
| "Something urgent changed" | **No** | No urgent-change flow anywhere. |

**2 of 5 implemented, and the "I can drive" one is scoped to declined drives only.** For the test week, the missing child-absence flow is the most likely to bite — a parent whose child is sick on Tuesday has no in-app way to remove them from that day's trips. They'd have to text Ryan, who would have to run SQL or regenerate.

---

## 10. Directory screen (overlay, opened from Home)

**What the user sees:** All active parents grouped by household. Coordinator badge on Ryan. Phone and email shown only when the parent has opted in (`share_phone` / `share_email`).

**What works:** Every pilot parent has `share_phone = true` and `share_email = true`, so the directory is fully populated. The coordinator badge is visible. The grouping by household is clear.

**Issues:**
- **No call/text action.** The directory shows phone numbers as text, not as `tel:` links. A parent who wants to call another parent has to copy the number into their phone app manually. The PRD §7 says "The app should provide a prominent call/text contact action for assigned adults" — the directory doesn't do this.

---

## 11. FAQ screen (overlay, opened from Home)

**What the user sees:** 9 sections of static content explaining how the carpool works — the weekly rhythm, what "tentative" means, how to confirm, how to decline, riding buddies, priority, fairness, privacy, and what's not included.

**What works:** The FAQ is extensive and well-written. It explains the Saturday check-in / Sunday confirmation / publish cycle. It explains the difference between availability and commitment. It explains buddy preferences and priority.

**Issues:**
- **The FAQ is not a tab.** The parent-pilot email says "There's a FAQ tab in the app." It's not a tab — it's a sheet opened from a Home link. Minor, but the email is wrong.

---

## 12. DriveDetail screen (overlay, opened from This Week drive card)

**What the user sees:** Trip time, route (origin → destination), driver name, vehicle label, and a grid of child photos with first names.

**What works:** The photo grid is a nice touch — a driver can visually confirm they have the right kids.

**Issues:**
- **No status shown.** Like the This Week drive cards, the DriveDetail screen doesn't show whether the driver is tentative or confirmed. A family can't tell if this is a confirmed ride or a proposed one.
- **No contact action.** The driver's phone/email isn't shown here, even though the directory has it. A parent who wants to contact the driver has to go to the directory, find the driver's household, and look them up. The PRD §7 wants a "prominent call/text contact action for assigned adults" on the trip view.

---

## Summary — what to fix for the test week

### Must-fix (will confuse or mislead real families)
1. **Tentative vs confirmed on This Week** — add a status pill to drive cards and DriveDetail. Without this, the test week doesn't actually test the confirmation cycle.
2. **Deadline displayed in UTC** — fix the deadline rendering to use the group timezone. "Confirm by Sun 8:00 AM" will confuse every family on Sunday morning.
3. **UTC "today" bug** — centralize `todayInGroupTimezone()` so the week rolls over at the right time for SF families.

### Should-fix (will bite the coordinator)
4. **Supersede-destroys-published** — fix the unconditional supersede in `generate-schedule` so regenerating a published week with uncovered trips doesn't nuke the live schedule.
5. **Tentative counted as confirmed in `uncovered` flag** — add `confirmed_seat_count` so the coordinator's coverage dashboard is accurate.

### Nice-to-have (would improve the test week but won't block it)
6. **Uncovered alerts get an "I can drive" button** — currently only declined drives get the volunteer action.
7. **`tel:` links in the directory** — so parents can actually call each other.
8. **Child-absence quick change** — so a sick kid can be removed mid-week without SQL.

### Defer to after the test week
- Expiration of unconfirmed assignments (P0 for Aug 17, not for Aug 10)
- `max_drives` UI
- Coordinator manual override, version comparison, member management
- Real-time updates on Home/This Week/Coordinator
- The `send-push` security hardening
- The dead-schema cleanup
- The kidpool → Carpool Crew rename