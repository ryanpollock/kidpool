# Carpool Crew

Phone-first web app that helps Clarendon families coordinate shared rides between Midtown Terrace and Presidio Middle School.

**Live app:** [carpoolcrew.co](https://carpoolcrew.co) (also at [kidpool-sf.vercel.app](https://kidpool-sf.vercel.app))

## What it does

- **Google sign-in** — parents authenticate with their existing Google account
- **Household setup** — add children, vehicle, and seat capacity
- **Weekly check-in** — toggle rides per child, set driving preference and max drives
- **Schedule generation** — coordinator runs a deterministic greedy algorithm that assigns drivers and riders across all trips for the week
- **Driver confirmation** — assigned drivers confirm or decline (with optional reason); confirm-all on the home screen
- **Publication** — coordinator publishes the final roster; all parents see it on the This Week tab
- **Coverage alerts** — uncovered trips surface immediately for coordinator recovery

## Tech stack

- **Frontend:** React 19, TypeScript 7, Vite 8, Motion, Radix UI icons
- **Backend:** Supabase (Postgres + RLS + Auth + Edge Functions)
- **Scheduling:** Pure TypeScript greedy algorithm (`greedy-v1`), swappable behind a version column
- **Hosting:** Vercel (auto-deploys from GitHub `main`)
- **Testing:** Node test runner (91 tests) + Playwright E2E (12 tests)

## Getting started

### Prerequisites

- Node.js 22+
- A Supabase project with the schema applied (see `supabase/migrations/`)

### Install and run

```bash
npm install
cp .env.example .env.local  # fill in your Supabase URL and publishable key
npm run dev                  # starts Vite dev server on :5173
```

### Build

```bash
npm run build    # tsc + vite build + Sites worker preparation
```

## Testing

```bash
npm test                  # foundation + sites (no live DB needed)
npm run test:integration  # 13 tests against live Supabase (needs service key in keychain)
npm run test:runtime      # Playwright mobile-runtime + E2E tests
```

Test breakdown (157 total):
- 58 foundation (schema, RLS, auth, household, check-in, confirmation, security, audit, reliability)
- 45 scheduling (algorithm, pressure, adversarial edge cases, riding buddy)
- 4 sites worker
- 18 integration (live Supabase RLS, RPCs, Edge Function, riding buddy DB + Edge Function)
- 32 runtime (Playwright: 8 mobile-runtime + 15 E2E + 5 journeys + 4 exploratory)

## Project structure

```
src/
  Prototype.tsx          # All app screens and logic
  prototype.css          # App-specific styles
  lib/supabase/           # Typed repository and config
  mobile/                 # Protected mobile runtime (do not edit)
supabase/
  migrations/             # SQL schema (17 tables, RLS, RPCs, triggers)
  functions/              # generate-schedule Edge Function (Deno)
  seed.sql                # Pilot group seed data
tests/                    # All test files
OPS.md                    # Operations runbook
```

## Architecture decisions

- **RLS everywhere** — no client-side data access bypasses Postgres row-level security
- **Pure algorithm** — the scheduler is pure TypeScript with zero runtime imports, swappable behind `algorithm_version`
- **Regeneration with confirmation** — coordinators can regenerate after publishing; the prior version is superseded and a confirmation dialog prevents accidental replacement
- **Single vehicle per household** — multiple-vehicle support deferred
- **Coordinator role via SQL** — no UI for assigning coordinators in the MVP

## Operations

See [OPS.md](OPS.md) for the production runbook: backup/recovery, admin access, coordinator SQL, Edge Function deployment, emergency fallback, audit trail, and privacy/retention.