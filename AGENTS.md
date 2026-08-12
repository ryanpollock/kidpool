# Mobile Prototype Agent Guide

## Prototype Instructions

In ChatGPT Work Mode, run `sites-preview start "$PWD"`, open `http://terminal.local:4173/` in the cloud browser, and verify the rendered app and its primary interactions. Keep that preview open and tell the user to inspect it in the cloud browser; do not present the local URL as a user-facing chat link. In Codex Desktop, run the local server yourself, open the preview in the in-app browser, and provide the clickable local URL. Do not deploy to Sites unless the user explicitly asks to share, publish, or deploy. Do not give the user server-start instructions when you can run it.

### Product-specific direction

- Prioritize operational clarity over visual novelty.
- Use the selected "Next Action First" mobile concept as the visual target.
- A driver confirmation request must dominate the home screen until explicitly resolved.
- Offered, tentative, confirmed, and uncovered states must never be visually interchangeable.
- Build the Saturday household check-in, Sunday driver confirmation, weekly roster, and coordinator coverage recovery as the core interactive prototype flows.
- The Admin tab (formerly Status) is coordinator-only and acts as a triage board: "Needs your attention" (uncovered trips, declined drives, not-started households) → "On track" summary → "The week" (trip demand + household responses) → "Overrides" (de-emphasized generate/publish with automation copy).
- Schedule generation and publication are automated via pg_cron (Sat 3 PM PD generates the draft, Sun 8 PM PD regenerates and auto-publishes). The coordinator's manual generate/publish buttons are overrides, not required steps.
- The admin can manually assign any active member with a vehicle to an uncovered trip via the `manually_assign_driver` RPC, regardless of the driver's stated availability.
- Today emphasis: the This Week tab and Home screen treat the current pilot-timezone date as "today" only when the displayed week contains it. Today's day card gets a teal tint + left accent bar + a bold `TODAY` chip; today's legs read `TODAY · Tuesday Morning` (full weekday). Home flips its hero to `TODAY` / "You're driving today" when the user has a drive today, and today's rows sort to the top with a chip + accent. Other days stay muted. The day-name + today treatment is intentionally scoped to This Week and Home — Review, Drive-detail, and alert screens still use the short `tripLabel`.

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
npm test                    # 82 foundation + 7 admin-automation + 54 scheduling + 4 sites = 147 tests (no live DB)
npm run test:integration   # 22 tests against live Supabase (needs service key in macOS keychain)
npm run test:runtime       # Playwright: 8 mobile-runtime + 22 E2E + 5 journeys + 4 exploratory = 39 tests
npx tsc --noEmit           # TypeScript check
npm run check:runtime      # Mobile runtime integrity (28 protected files)
npm run build              # Full production build (uploads source maps to Sentry if SENTRY_AUTH_TOKEN is set)
```

All 208 tests must pass before pushing to `main`.

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
