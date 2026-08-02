# Contributing — Midtown Carpool (kidpool)

Phone-first carpool coordination app for Clarendon Presidio families. Built with React 19, TypeScript, Vite, Supabase, and a mobile device runtime prototype kit.

## Quick start

```bash
npm install
npm run dev:staging      # local dev against staging Supabase (demo families)
```

Open the app in your browser. On staging, the sign-in screen shows a "Demo accounts" panel with clickable chips for each seeded family (password `SeedPass123!`). You can also sign in with `?testAuth=email|password` in the URL.

## Prerequisites

- Node 22+
- Supabase CLI (`npm install -g supabase`)
- Vercel CLI (`npm install -g vercel`) — only needed for manual deploys or env var changes
- Access to the GitHub repo `ryanpollock/kidpool`

## Two environments

| | Production | Staging |
|---|---|---|
| **Supabase** | `ujcrnrcgbvzyqosykkjy` | `jfyjgmhqnlbdcafoarrg` |
| **Frontend** | `kidpool-sf.vercel.app` | `kidpool-staging.vercel.app` |
| **Data** | Real pilot families | 10 demo families (`@seed.kidpool`) |
| **Auth** | Google OAuth only | Google OAuth + `?testAuth=` bypass + demo panel |

Switch Supabase CLI between projects:
```bash
npm run link:prod   # supabase link --project-ref ujcrnrcgbvzyqosykkjy
npm run link:test   # supabase link --project-ref jfyjgmhqnlbdcafoarrg
```

All test/seed scripts default to staging and abort if run against production. `delete-user` targets production by default.

## Local → Staging → Production workflow

```
┌─────────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐
│  Local dev  │────▶│  PR      │────▶│ Staging │────▶│ Production│
│             │     │  preview │     │  site   │     │   site   │
└─────────────┘     └──────────┘   └───┬────┘   └────┬─────┘
   dev:staging        Vercel build    Vercel +        Vercel +
   against staging    (staging env)   GitHub Action   GitHub Action
                                      (staging)       (production)
```

### 1. Local development

```bash
git checkout staging && git pull
git checkout -b feature/my-change
npm run dev:staging
```

Test against staging Supabase. Use the demo accounts panel or `?testAuth=email|password`.

### 2. Run tests before pushing

```bash
npm test                 # 101 foundation + scheduling + sites tests (no live DB)
npm run test:integration # 13 tests against live staging Supabase (needs service key in macOS keychain)
npm run test:runtime     # 20 Playwright (8 runtime + 12 E2E)
npx tsc --noEmit
npm run check:runtime    # mobile runtime integrity (28 protected files)
npm run build            # full production build
```

All tests must pass before pushing to `main`.

### 3. Push feature branch → PR preview

```bash
git push origin feature/my-change
# Open a PR on GitHub
```

Vercel auto-builds a PR preview URL using **staging** env vars. Test on that URL before merging.

### 4. Merge to staging

```
Merge the PR into the staging branch (or merge feature branch into staging).
```

Auto-deploys:
- **Vercel** → `kidpool-staging.vercel.app`
- **GitHub Action** → Edge Functions to staging Supabase

Test on the staging site (demo panel visible, `?testAuth=` bypass active).

### 5. Merge staging → main

```bash
git checkout main && git merge staging && git push origin main
```

Auto-deploys:
- **Vercel** → `kidpool-sf.vercel.app` (production)
- **GitHub Action** → Edge Functions to production Supabase

No demo panel, no `?testAuth=` bypass — real Google OAuth only.

## What's automated vs manual

### Auto-deployed (push to branch triggers deploy)

| Push to | Frontend (Vercel) | Edge Functions (GitHub Action) |
|---|---|---|
| `staging` | `kidpool-staging.vercel.app` | staging Supabase |
| `main` | `kidpool-sf.vercel.app` | production Supabase |

The GitHub Action lives at `.github/workflows/deploy-edge-functions.yml` and uses the `SUPABASE_ACCESS_TOKEN` GitHub secret. It deploys `generate-schedule` and `send-push` with `--no-verify-jwt` (each function does its own JWT/auth check internally).

### Manual (staging first, then production)

| Task | Command |
|---|---|
| DB migrations | `supabase db query --linked -f supabase/migrations/<file>.sql` |
| Supabase secrets | `supabase secrets set KEY=value` |
| Seed demo data | `npm run seed-demo` (staging only) |
| Reset demo data | `npm run delete-seed` (staging only) |
| Vercel env vars | `vercel env add/rm` — Production and Preview separately |

**DB migrations** must be applied to staging first, tested, then applied to production:
```bash
# Staging
npm run link:test
supabase db query --linked -f supabase/migrations/<new>.sql
# Test on staging site
# Production
npm run link:prod
supabase db query --linked -f supabase/migrations/<new>.sql
```

## Codebase structure

```
src/
  Prototype.tsx        # main app UI (all screens)
  prototype.css        # all styles
  lib/supabase/        # repository, types, client
supabase/
  migrations/          # SQL migrations
  functions/
    generate-schedule/ # scheduling algorithm + write logic
    send-push/         # web push notifications
    _shared/           # shared types, scheduling code, CORS
scripts/
  seed-demo-families.mjs  # seed 10 demo families (staging)
  delete-seed.mjs         # delete demo data (staging)
  delete-user.mjs         # hard-delete a real user (production)
  pipeline-simulation.mjs # end-to-end scheduling simulation
tests/
  *.test.mjs           # foundation + scheduling + integration tests
  app-e2e.spec.ts      # Playwright E2E
```

## Editing rules

- Build app UI in `src/Prototype.tsx` and `src/prototype.css` only.
- Do not edit protected runtime files (`src/App.tsx`, `src/main.tsx`, `src/mobile/`, `vite.config.ts`, etc.) unless explicitly changing the mobile runtime.
- Run `npm run check:runtime` before preview or handoff. If it fails, restore the protected runtime.
- `database.types.ts` is hand-authored — keep it in sync with migrations.
- Never put `SUPABASE_SERVICE_ROLE_KEY` or any secret in a `VITE_*` variable. Browser-side code only uses the publishable anon key; RLS enforces authorization.

## Hard-deleting a real user

```bash
npm run delete-user <email>          # aborts if household has other active members
npm run delete-user <email> --force  # deletes entire household including co-parents
```

Defaults to production. Deletes profile, auth user, household, children, vehicles, checkins, assignments, and audit events in FK-safe order. Published schedules are preserved (`generated_by` set to NULL).

## See also

- `AGENTS.md` — full agent guide, testing details, demo family table, staging isolation
- `OPS.md` — production operations runbook (backup, recovery, admin access, emergency fallback)