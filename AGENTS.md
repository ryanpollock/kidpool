# Mobile Prototype Agent Guide

## Prototype Instructions

In ChatGPT Work Mode, run `sites-preview start "$PWD"`, open `http://terminal.local:4173/` in the cloud browser, and verify the rendered app and its primary interactions. Keep that preview open and tell the user to inspect it in the cloud browser; do not present the local URL as a user-facing chat link. In Codex Desktop, run the local server yourself, open the preview in the in-app browser, and provide the clickable local URL. Do not deploy to Sites unless the user explicitly asks to share, publish, or deploy. Do not give the user server-start instructions when you can run it.

### Product-specific direction

- Prioritize operational clarity over visual novelty.
- Use the selected "Next Action First" mobile concept as the visual target.
- A driver confirmation request must dominate the home screen until explicitly resolved.
- Offered, tentative, confirmed, and uncovered states must never be visually interchangeable.
- Build the Saturday household check-in, Sunday driver confirmation, weekly roster, and coordinator coverage recovery as the core interactive prototype flows.
- Chat (5th tab) is parent-to-parent messaging: 1:1 DMs, custom group threads, and one all-parents "Everyone" thread per group. `src/ChatScreens.tsx` + `src/chat.css` own the chat UI (the sanctioned exception to "all app UI in Prototype.tsx" — recorded here per the plan decision). The thread screen renders as a `chat-thread-layer` sibling above the tab MobileScroll (header + composer overlay `mobile-page`, which is absolutely positioned `inset:0` by the runtime); the inbox is normal tab content. Composer must use `KeyboardTextarea` + `useKeyboardInsets().bottomInset`; back navigation calls `keyboard.hide()` before popping. Composer keyboard behavior is a product decision: **Enter sends, Shift+Enter forces a newline** (guarded by `isComposing` so IME confirmation never sends); the textarea auto-grows to 96px and resets when the draft clears.
- **Every text-entry control must render at `font-size: 16px` or larger** — the iOS no-auto-zoom threshold. Anything smaller makes iPhone Safari zoom the whole page on focus and KEEP that zoom after the keyboard closes, so the app appears "rendering too wide" with the right side clipped off-screen (a production iPhone report on the composer, which was 14px). `maximum-scale=1` in the viewport meta is deliberately NOT used — it's an accessibility anti-pattern and iOS ignores `user-scalable=no`. The contract test in `tests/chat.test.mjs` enforces the threshold across `chat.css` and `prototype.css`.
- Chat CSS composes with prototype.css classes (`.subpage-header`, `.icon-button`, `.primary-button`), so colliding rules MUST win by specificity, never by CSS load order — chat.css and prototype.css load order is not guaranteed. `.subpage-header.chat-thread-header` exists because prototype's `.subpage-header { grid-template-columns: 36px 1fr }` and `.subpage-header h1 { font-size: 34px }` otherwise wrap the mute bell onto a second row over the message list (a production-reported overlap). Also: pseudo-elements (`::after`) don't render on SVG elements — decorative overlays (like the mute slash) must live on an HTML wrapper span, and the mute state surfaces a pinned "Muted" flag in the thread subtitle so the toggle is visibly doing something.
- Crew AI is the in-chat coordinator agent (M2, ships disabled): it reads every thread as a visible participant (sender_kind='agent', sender_name='Crew AI'), answers schedule questions, and posts structured `chat_proposals` (cancel_ride / switch_slot / swap_drive / coverage_fill) rendered as cards. The LLM never mutates the schedule directly — `confirm_chat_proposal` executes the existing invariant-enforcing RPCs transactionally after the required parent confirms (button tap or detected in-thread consent). Nothing changes unless a parent says OK.
- Coordinator oversight: while `groups.coordinator_chat_access` is true, coordinators read and post in ALL group threads (RLS via `can_read_chat_thread`). This near-term flag exists to be flipped off once Crew AI has earned trust — coordinators then see only threads they participate in. Do not remove the flag.
- Chat disclosure: every thread creation posts a system note that Crew AI will be in the conversation and that nothing changes without a parent's OK. Do not remove the disclosure.
- The Chat tab's unread badge is an app-level concern in Prototype.tsx, not the inbox's: a count refresh (`refreshChatUnread`, muted threads excluded) runs when identity resolves — so the badge is present at sign-in before the tab is ever opened — and a nav-level realtime channel (`chat-threads-nav:<group_id>`, RLS-enforced delivery, ~1.5s debounce for bursts) re-counts on message activity from any tab. Thread opens re-sync via `handleChatThreadOpened`. Count source is `list_chat_threads`; swap to a dedicated count RPC only if scale warrants it.
- Chat notifications are push-only (no email): the `chat_messages` AFTER INSERT trigger POSTs to send-push via pg_net (fail-soft vault pattern); the `chat_message` branch skips the sender, muted participants (`notifications_muted`), and non-active members, and deep-links to `/#thread=<id>` (the SPA parses it on load and opens the thread). One notification per thread (`tag: chat-<thread_id>` replaces).
- **App icon badge (iOS home-screen web apps + desktop Chrome):** the `chat_message` push payload carries the recipient's TOTAL unread via `count_unread_chat(target_profile_id)` (mirrors the in-app badge: muted threads excluded, read cursors respected, active membership required — migration `202609090001`). The service worker calls `navigator.setAppBadge(payload.badge)` on push; the app re-syncs it via `syncAppIconBadge` on every `refreshChatUnread` and clears it on sign-out. All paths feature-detect and fail soft (Android and in-browser are no-ops).
- **Chat deep links must survive the service-worker install reload:** a first SW takeover (`skipWaiting` + `clients.claim`) fires a controllerchange reload AFTER the `#thread=` hash is read but BEFORE identity is ready — the captured id is stashed in sessionStorage (`consumeChatDeepLink`) and only cleared once the thread actually opens. Never strip the hash before the open lands.
- The Admin tab (formerly Status) is coordinator-only and acts as a triage board: "Needs your attention" (uncovered trips, declined drives, not-started households) → "On track" summary → "The week" (trip demand + household responses) → "Overrides" (de-emphasized generate/publish with automation copy).
- Schedule generation and publication are automated via pg_cron: Saturday is check-in collection only (reminders at 9 AM, 6 PM, and 11 PM Pacific; deadline Sat 11:59 PM — no draft generation on Saturday). Sunday 7 AM Pacific generates the draft with all check-ins (`generate-schedule-sunday-morning`), confirmation reminders go out Sun 8 AM and 5 PM (deadline 7 PM), and Sunday 7 PM Pacific auto-publishes the draft as-is with unconfirmed drivers left tentative (`auto-publish-sunday`). The coordinator's manual generate/publish buttons are overrides, not required steps.
- The admin can manually assign any active member with a vehicle to an uncovered trip via the `manually_assign_driver` RPC, regardless of the driver's stated availability.
- Multi-vehicle households: households may have several active vehicles, each tagged with its primary driver via `vehicles.default_driver_id`. There is no car picker at check-in — `resolveDriverVehicle` (carpool-repository, mirrored in the volunteer RPCs' SQL) resolves "your car" automatically: the vehicle tagged to the parent, else the household's single active vehicle, else the smallest-capacity one (never overstates a car). The Account screen lists vehicles with add/edit/remove and a "Who drives this car?" tag for multi-car households. The scheduler was already per-driver (it reads each parent's `driver_availability.vehicle_id`), so no scheduler changes were needed. The shared-car rule stands: at most one driver per household per trip.
- Today emphasis: the This Week tab and Home screen treat the current pilot-timezone date as "today" only when the displayed week contains it. Today's day card gets a teal tint + left accent bar + a bold `TODAY` chip; today's legs read `TODAY · Tuesday Morning` (full weekday). Home flips its hero to `TODAY` / "You're driving today" when the user has a drive today, and today's rows sort to the top with a chip + accent. Other days stay muted. The day-name + today treatment is intentionally scoped to This Week and Home — Review, Drive-detail, and alert screens still use the short `tripLabel`.
- Parent photos: parents upload their own avatar via the `parent-avatars` Storage bucket (RLS keyed on `auth.uid()`), surfaced through `repository.uploadParentAvatar` + `updateCurrentProfile({avatarUrl})`. Home shows a dismissible "Add your photo" nudge when `profile.avatar_url` is null. Google OAuth still seeds the avatar on signup; manual upload overrides it. The `child-photos` bucket remains for child photos (RLS keyed on household membership).
- Kid phone numbers: `children.phone` (text, nullable) is an optional direct-contact number provided by the parent in the Account screen. Providing the number is the opt-in — there is no `share_phone` toggle because visibility is drive-scoped, not group-wide: the number surfaces only as a "Call {first_name}" `tel:` link on the `DriveDetailScreen` child card, visible to the driver assigned to that drive. No directory surface for kid phones.
- Home drive rows are clickable: `AssignmentRow` accepts an optional `onClick` that opens `DriveDetailScreen` via `setDriveDetailId`. The `findDriveDetail` render branch falls back to `homeSchedule` when `publishedSchedule` is null so draft-schedule drives are also openable from Home. Reacceptable (declined/expired) and Review-screen rows are intentionally NOT clickable (they aren't in any schedule's rosters, so the lookup would return null).
- Tap-to-enlarge photos: parent avatars and child photos are tappable to open a near-fullscreen `BottomSheet` lightbox (`snap={0.85}`) via the reusable `PhotoButton` component. Each instance manages its own open state. Placeholder icons (no photo) stay non-interactive. The AppHeader avatar (top-right) remains a navigation button that opens Account — it is NOT a photo viewer. Applied to Account (parent + child), Directory, and Drive detail; not to Review or alert screens.

Before planning or implementing any mobile-app change, read this `AGENTS.md` in full. It is the source of truth for the template's runtime and component guidance.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Editing Boundary

- Build app-specific UI in `src/Prototype.tsx` and `src/prototype.css`.
- Treat `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/mobile/`, `public/assets/iphone/`, `public/assets/android/`, `public/assets/status/`, `vite.config.ts`, `worker/index.js`, and `scripts/prepare-sites-build.mjs` as protected runtime files. Do not edit, replace, remove, or recreate them unless the user explicitly asks to change the mobile runtime itself. For an explicit runtime change, update the affected lock hashes only after verifying the new runtime behavior.
- Run `npm run check:runtime` before preview or handoff. If it fails, restore the protected runtime instead of weakening or bypassing the check.
- `npm run build` preserves the mobile runtime and prepares the static Cloudflare Worker output required by Sites. Before a Sites handoff, confirm `dist/client/index.html`, `dist/server/index.js`, `dist/.openai/hosting.json`, and source `.openai/hosting.json` exist, then run `npm run test:sites`. Do not replace this project with a Vinext starter.

## Runtime Contract

- Preserve the mobile device runtime unless the user's task explicitly asks otherwise. Do not replace it with a standalone page. Visual fidelity applies to app-owned content inside the device screen, not to template-owned device chrome.
- Keep `App` composed around `PhoneFrame` -> `KeyboardProvider`, with `StatusBar`, app content, `HomeIndicator`, and `KeyboardDock` mounted inside the phone frame. `StatusBar` and the iOS home indicator are overlaid device chrome. When the Android keyboard is closed, the app viewport reserves the protected navigation-bar region instead of painting behind it. When the Android keyboard is open, preserve the current full-screen keyboard layout: its asset includes the IME navigation strip and the separate black navigation bar is hidden. iOS screens continue to paint behind the home-indicator area and own their safe-area content padding.
- Preserve the `iPhone` / `Pixel 10` device picker and both calibrated device presets. The Pixel screen is `427 x 952`; its `32 x 32` camera circle and `public/assets/android/navigation-bar.svg` bottom navigation bar are protected device chrome, not app content.
- Preserve the device picker's intentionally lightweight Codex styling in the top-right corner: its trigger wrapper is borderless and transparent, its trigger sizes to content, and its right-aligned menu uses the compact 3px inset plus the specified hairline and elevation shadow layers. Keep the prototype root and default app screen white.
- Preserve `StatusBar` as live device chrome, including its platform-specific typography, source status-icon assets, and spacing. Pixel 10 uses Roboto, Android indicators, and 32px top, left, and right padding. iPhone uses its iOS indicators, system typography, and calibrated spacing. Do not hardcode screenshot times like `9:41` into the status bar, replace its real-time clock, or move status bar content into app markup unless the user explicitly asks for a fixed/mock device time.
- `PhoneFrame` owns the calibrated device frame, screen portal, device picker, camera cutout, and custom cursor. Keep device assets in `public/assets/iphone/` and `public/assets/android/`; if an asset fails to load, repair the asset path or restore the asset instead of removing the frame, keyboard, or image render.
- Use `MobileScroll` directly for simple single-screen prototypes. Use `FlowStack` for conventional multi-screen flows whose routes can own their fixed header and footer; when using it, define each route as a `FlowScreen`: `{ id, header?, headerHeight?, footer?, footerHeight?, render }`, and use `flow.push(screen)`, `flow.pop()`, and `flow.replace(screen)` from `FlowStack` render callbacks or `useFlow()` instead of introducing another router.
- Use `Carousel` for a carousel, horizontal rail, swipeable cards, image or media strip, horizontally scrollable cards, chip rail, or other horizontal collection.
- For a layered app shell—such as a persistent composer, independently presented sheet, pushed/peek sidebar, or app-wide transition—compose directly in `Prototype.tsx` rather than forcing it through `FlowStack`. Keep app-owned fixed chrome as sibling layers outside `MobileScroll`.
- When using `FlowScreen`, put route-owned fixed headers or footers in `FlowScreen.header` or `FlowScreen.footer`. Set `headerHeight` to the visible app-toolbar height; `FlowStack` adds the device's top safe-area/status-bar inset automatically. Do not include `StatusBar` or its height in the header. Set `footerHeight` to the full app-footer height. `FlowScreen.footer` is an overlay, not reserved layout space; screens using it must add their own bottom content padding such as `padding-bottom: calc(var(--flow-footer-height) + var(--mobile-safe-area-height) + 24px)` so final content can scroll above the footer while still painting behind it.
- Render only scrollable content inside `MobileScroll`; it is for content that should move with scroll and rubber-band overscroll. Keep app-owned headers, nav bars, tabs, composers, and overlays outside it. This keeps scroll physics, safe areas, keyboard insets, scrollbars, and drag click suppression active without letting content paint under fixed chrome.
- Buttons, links, cards, and images inside `MobileScroll` should still allow drag scrolling when the pointer moves beyond tap slop. Use `data-scroll-drag="ignore"` only for rare controls that must own the drag gesture themselves.
- Do not add `var(--keyboard-height)` to ordinary screen/content padding inside `MobileScroll`; the scroll viewport already shrinks above the simulated keyboard. For custom fixed composers, search bars, or toast chrome, use `useKeyboardInsets().bottomInset`. It is relative to the app viewport: Android returns `0` while the closed-keyboard viewport already reserves navigation, then returns the keyboard height while open; iOS continues to clear the home indicator while closed and ride directly above the keyboard while open. Do not pin custom bottom chrome to `bottom: 0` or only `keyboardHeight`.
- Use `KeyboardInput`, `KeyboardTextarea`, or `MobileTextField` for every text-entry control. A raw `input` or `textarea` disconnects focus, keyboard animation, safe-area insets, and attached surfaces.
- Use `BottomSheet` for phone-scoped sheets. Its props are `open`, `onOpenChange`, `title`, optional `description`, optional `snap`, and `children`; it renders through the phone screen portal and dismisses the keyboard before opening.

## Horizontal Carousels

- Use `Carousel` for horizontally draggable cards, images, media, chips, or other horizontal collections. Do not recreate these with `overflow-x`, custom pointer handlers, or a generic div.
- `Carousel` can be nested directly inside `MobileScroll`. It owns horizontal gestures and automatically yields vertical gestures to the parent.
- Never put `data-scroll-drag="ignore"` on or around a `Carousel`; doing so prevents vertical parent scrolling when a gesture begins inside it.
- Do not add CSS scroll snapping to `Carousel`; its runtime owns momentum and release motion.
- Use `data-scroll-drag="ignore"` only when a control must prevent parent scrolling in every drag direction.

See `src/mobile/COMPONENTS.md` for the full component and gesture contract.

## Keyboard Rule

The simulated keyboard is a separate top-layer component. Before presenting anything that behaves like iOS navigation or modal UI, dismiss it first.

Call `keyboard.hide()` before:

- pushing, popping, or replacing FlowStack routes
- opening bottom sheets, action sheets, dialogs, menus, or navigation sheets
- starting transitions where the destination should not inherit text-input focus

`FlowStack` already hides the keyboard for `push`, `pop`, and `replace`. `BottomSheet` already hides it before opening. If you add new modal/sheet/navigation primitives, follow the same rule.

When a composer, search surface, or other keyboard-attached component closes, call `keyboard.hide()` in the same event before changing that component's open state. Position attached surfaces from `useKeyboardInsets()` rather than a separate timer or visibility flag so both dismiss together.

When any text-entry control loses focus, dismiss the simulated keyboard. If the control is custom or does not use the runtime's keyboard-aware fields, handle its blur event and call `keyboard.hide()` explicitly. Keep the keyboard open only when focus is moving directly to another text-entry control that should share the same keyboard session.

## Interaction Rules

- Do not trigger buttons or inputs after a pointer has become a drag. Preserve the drag suppression behavior in `MobileScroll`.
- Do not allow native browser image/file dragging inside the phone frame. Preserve the phone-level `dragstart` suppression and non-draggable image styles so scroll drags that begin on images still scroll the prototype.
- Use `KeyboardInput`, `KeyboardTextarea`, or `MobileTextField` for text entry so the simulated keyboard and safe-area insets stay connected.
- Fixed phone chrome should not animate with pushed screens. Screen content can animate; the status bar, camera cutout, and preview chrome should stay put.
- Keep the keyboard below the home indicator/safe area layer in z-index, and above ordinary app UI while visible.
- Keep the home indicator as the topmost safe-area layer in the z-index above everything else in the prototype.

## Testing

Run these before considering any change complete:

```bash
npm run check:contracts       # 166 static contract checks (no live DB, ~1s)
npm run test:integration:local # 25 integration tests against local Supabase (~19s)
npm run test:runtime          # Playwright: 8 mobile-runtime + 22 E2E + 5 journeys + 4 exploratory = 39 tests
npx tsc --noEmit              # TypeScript check
npm run check:runtime         # Mobile runtime integrity (28 protected files)
npm run build                 # Full production build (uploads source maps to Sentry if SENTRY_AUTH_TOKEN is set)
```

All behavioral tests must pass before pushing to `main`: `npm run test:all`.
- `check:contracts` (166 static checks) + `test:integration:local` (25) + `test:sites` (4) + `test:runtime` (Playwright) + `tsc` + `check:runtime`
- The 166 "foundation" tests are static contract checks (grep SQL/source for patterns), not behavioral tests. They run as `npm run check:contracts` and are included in `test:all`.

### Dev test-auth bypass

In development mode (`import.meta.env.DEV`), the app accepts `?testAuth=email|password` as a URL parameter to sign in with email/password instead of Google OAuth. This is stripped from production builds. Used by `tests/app-e2e.spec.ts` to create and sign in test users without OAuth.

### Staging and test isolation

Two Supabase projects:
- **Production:** `ujcrnrcgbvzyqosykkjy` — real pilot data only
- **Staging:** `jfyjgmhqnlbdcafoarrg` — demo families, integration tests, E2E tests, pipeline simulations

Switch between them with:
```bash
npm run link:test   # supabase link --project-ref jfyjgmhqnlbdcafoarrg (staging)
npm run link:prod   # supabase link --project-ref ujcrnrcgbvzyqosykkjy (production)
```

`.env.local` points to production (used by Vercel builds). `.env.staging.local` points to staging. E2E tests run `npm run dev:staging` (Vite `--mode staging`) to load staging env vars.

All test/seed scripts (`seed-demo`, `pipeline-sim`, `integration.test.mjs`, `app-e2e.spec.ts`) default to staging and abort if `PROJECT_REF` is production. `delete-user` defaults to production (ops tool). All scripts verify the CLI's linked project matches `PROJECT_REF`.

### Integration test data cleanup

Integration and E2E tests create auth users and DB rows with `@test.kidpool` and `@e2e.kidpool` email domains. The cleanup functions delete ALL data for the pilot group (`c1000000-0000-4000-8000-000000000001`) — not just `deadbeef`-prefixed IDs — because the `weeks` table has a `unique(group_id, starts_on)` constraint that blocks inserts if stale weeks from other tests remain.

### Demo family data

10 demo families seeded via `npm run seed-demo` with `@seed.kidpool` email domain. Seeds against staging only. All use password `SeedPass123!`.

| Family | Kids | Vehicle seats | Max drives | Edge case |
|---|---|---|---|---|
| Chen | 2 | 4 | 3 | **Coordinator**, standard driver |
| Garcia | 1 | 3 | 3 | Afternoon-only driver |
| Johnson | 2 | 5 | 5 | High-capacity, all-day |
| Patel | 1 | — | 0 | Pure rider, no vehicle |
| Williams | 3 | 4 | 3 | Large family |
| O'Brien | 2 | 3 | 3 | Afternoon driver |
| Anderson | 4 | 3 | 2 | More riders than seats |
| Thompson | 1 | 7 | 1 | Big car, barely drives (volunteer candidate) |
| Martinez | 2 | — | 0 | Pure rider, no vehicle |
| Lee | 1 | 5 | 0 | Has car, max_drives 0 (volunteer edge case) |

```bash
npm run seed-demo       # seed 10 families into staging
npm run delete-seed     # delete all @seed.kidpool data from staging
```

### Priority child scheduling

The `children.is_priority` column (boolean, default `false`) marks a child for guaranteed seat allocation. When the scheduling algorithm has a seat available on a trip, a priority child wins that seat before any non-priority rider — including over another child's buddy-in-car advantage. Priority is the first tiebreaker in the `while`-loop seat selection in `greedy-v1.ts`, ahead of buddy-in-car and name sort.

### Chat data model

Tables (all RLS'd via the `can_read_chat_thread(target_thread_id uuid)` helper): `chat_threads` (kind dm/group/everyone; DM pairs canonicalized `dm_a_id < dm_b_id`, one per pair per group; one everyone-thread per group), `chat_participants` (read cursor `last_read_at`, `notifications_muted`; auto-enrolled into the everyone thread by the memberships insert trigger), `chat_messages` (immutable; `sender_kind` parent/agent/system; sender name/avatar denormalized at insert), `chat_proposals` (Crew AI's structured change cards; confirm/decline RPCs only). All three are in the `supabase_realtime` publication with `replica identity full` so Realtime enforces RLS. Threads RPCs: `ensure_everyone_thread`, `create_dm_thread`, `create_group_thread`, `mark_thread_read`, `set_thread_notifications_muted`, `list_chat_threads` (inbox). Run chat tests: `node --test tests/chat.test.mjs` (contracts), `npm run test:runtime:local -- --grep "Chat"` (E2E), chat integration tests live at the end of `tests/integration.test.mjs`. `tests/chat-multi-user.spec.ts` covers real-human multi-session patterns (two-way conversations, three-way threads, DM badge/reply loops, live inbox rows, Shift+Enter multiline, and the UI-driven proposal Confirm against a real generated schedule).

### Migration numbering note

Two migrations briefly shared the version number `202609010003` (fix_reminder_cron_schedule + switch_afternoon_trip), which broke fresh `supabase start`/`db reset` (schema_migrations PK conflict) — CI was failing at stack startup before Sep 7, 2026. `switch_afternoon_trip` was renamed to `202609010004_…`. Never reuse a version number; the tracker treats filename prefix as the version.

### Spec/dev-server target pairing note

Playwright spec target must match the dev server playwright.config starts: `dev:test` (local Supabase) only when `TEST_DB_TARGET=local`, otherwise `dev:staging`. `getSpecEnv()` in tests/lib/playwright-helpers.ts pairs accordingly. Before Sep 8, 2026 it defaulted to local under plain `npm run test:runtime`, so helper-based specs (reassignment, chat) created users on local while the app ran against staging — every sign-in failed with "Invalid login credentials" (part of why CI Playwright had been red since Aug 20). The legacy specs (app-e2e, pilot-scenarios, etc.) hardcode staging in-file and only work under `npm run test:runtime` (staging mode). Also: never leave a stray vite dev server on the Playwright port — `reuseExistingServer` will silently reuse a mismatched-mode server.

Hard constraints still apply: if a trip has zero eligible drivers (no availability, all at `max_drives`, all declined/expired), a priority child is uncovered like anyone else. The guarantee is: **if any seat is available, the priority child gets it before any non-priority rider.**

Sara Pollock (`first_name='Sara'`, `last_name='Pollock'`) is marked priority in both staging and production via `202608030006_set_priority_sara.sql`. If Sara is deleted and re-added via the app, re-run that migration to re-apply the flag (the app's `createChild` insert defaults `is_priority` to `false`). The match is by name, not ID, so it's idempotent and survives row recreation.

Sara's own `preferred_buddy_child_id` continues to work for co-placement: once she's assigned to a car, her buddy gets buddy-in-car priority for that car. Set buddy preferences bidirectionally (Sara → buddy AND buddy → Sara) for best results.

No UI toggle exists yet; `is_priority` is managed via SQL. A coordinator-screen switch is future scope.

### Staging sign-in

The staging site (`kidpool-staging.vercel.app`) supports both Google OAuth and email/password via the `?testAuth=email|password` bypass. The bypass is enabled when `VITE_SUPABASE_URL` contains the staging project ref (baked at build time). The sign-in screen shows a "Demo accounts" panel with clickable chips for each demo family. Production builds never show the bypass or the panel.

### Hard-deleting a real user account

```bash
npm run delete-user <email>          # aborts if household has other active members
npm run delete-user <email> --force  # deletes entire household including co-parents
```

Deletes profile, auth user, household, children, vehicles, checkins, assignments, rider_assignments, and audit events in FK-safe order. `schedule_versions.generated_by` is set to NULL (published schedules preserved). Defaults to production; override with `SUPABASE_PROJECT_REF`. Requires Supabase CLI linked to the target project. See `scripts/delete-user.mjs`.

## Deployment

- **GitHub repo:** `ryanpollock/kidpool` (public)
- **Vercel project:** `kidpool` — connected to GitHub, auto-deploys both `main` and `staging` branches
- **Production URL:** `https://carpoolcrew.co` (also `https://kidpool-sf.vercel.app`; auto-deploys on push to `main`)
- **Staging URL:** `https://kidpool-staging.vercel.app` (auto-deploys on push to `staging`)
- **Production Supabase:** `ujcrnrcgbvzyqosykkjy` — auth `site_url` set to `https://kidpool-sf.vercel.app`
- **Staging Supabase:** `jfyjgmhqnlbdcafoarrg` — auth `site_url` set to `https://kidpool-staging.vercel.app`
- **Edge Functions:** auto-deployed by GitHub Action (`.github/workflows/deploy-edge-functions.yml`) on push to `main` (production) and `staging` (staging)

### Workflow: staging-first

```
1. git checkout staging && git pull
2. git checkout -b feature/my-change     # new branch from staging
3. ...make changes...
4. git push origin feature/my-change
   → Vercel auto-builds a PR preview URL (staging env vars)
   → Test on the PR preview URL
5. Open PR, merge to staging
   → Vercel auto-deploys to kidpool-staging.vercel.app
   → GitHub Action deploys Edge Functions to staging Supabase
   → Test on staging site
6. Merge staging to main
   → Vercel auto-deploys to carpoolcrew.co (also kidpool-sf.vercel.app, production)
   → GitHub Action deploys Edge Functions to production Supabase
```

### What stays manual

- **DB migrations:** Apply to staging first (`npm run link:test && supabase db query --linked -f <file>`), test, then apply to production (`npm run link:prod && supabase db query --linked -f <file>`)
- **Seed data:** `npm run seed-demo` / `npm run delete-seed` (staging only)
- **Supabase secrets:** `supabase secrets set` (manual per project)
