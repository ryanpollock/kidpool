# Crewmate AI Phase 1 — deployment and enablement runbook

Crewmate ships **disabled**: nothing runs for a group until a coordinator
flips `groups.crewmate_enabled`. This runbook takes a group from
"code merged" to "agent live" — staging first, always.

Spec: `CREWMATE_REQUIREMENTS.md` (repo root). Phase 1 is Q&A-only: the
agent answers schedule questions and never writes the schedule.

## 0. Prerequisites

- Local stack for development: `npm run db:start` (Docker must be running).
  The migration applies on `npm run db:reset`; for a running stack apply
  it directly: `supabase db reset` (local) — never partial `db push`.
- Staging/production secrets live in Supabase secret manager, never in the
  repo.

## 1. Apply the migration

```bash
# staging first
npm run link:test
supabase db query --linked -f supabase/migrations/202609140001_crewmate_phase1.sql

# then production (only after staging has been verified end to end)
npm run link:prod
supabase db query --linked -f supabase/migrations/202609140001_crewmate_phase1.sql
```

What it creates: `groups.crewmate_enabled` (false) + `crewmate_monthly_token_budget`,
the `agent` thread kind + `ensure_agent_thread`, the `crewmate_runs` ledger +
`claim_crewmate_run`, the `crewmate_readonly` role + `crewmate_readonly_query`
RPC, and the `notify_chat_agent` trigger.

## 2. Deploy the function

Push to `staging` (or `main`) — the GitHub Action deploys `chat-agent`
automatically. Manual equivalent:

```bash
supabase functions deploy chat-agent --no-verify-jwt
```

`send-push` must also be redeployed with the same push (it gains the
agent-reply push branch for private Crewmate threads).

## 3. Set secrets (per project, manual)

```bash
supabase secrets set TOGETHER_API_KEY=<key>
# optional overrides (defaults: google/gemma-4-31b-it, deepseek-ai/DeepSeek-V4-Flash)
supabase secrets set CREWMATE_TRIAGE_MODEL=...
supabase secrets set CREWMATE_PLANNER_MODEL=...
```

Verify the model IDs exist on the account before enabling:

```bash
curl -s -H "Authorization: Bearer $TOGETHER_API_KEY" https://api.together.xyz/v1/models | grep -i -E "gemma|deepseek"
```

## 4. Run the eval gate (must pass BEFORE enabling)

Triage gate (no DB needed, runs from your laptop):

```bash
TOGETHER_API_KEY=<key> npm run eval:crewmate          # triage; PASS at >= 85%
```

Full-pipeline gate on staging (needs steps 1–3 done on staging, demo
families seeded via `npm run seed-demo`, and the flag on):

```bash
npm run link:test
# enable the pilot group on staging:
supabase db query --linked -c "update public.groups set crewmate_enabled = true where id = 'c1000000-0000-4000-8000-000000000001';"
TOGETHER_API_KEY=<key> npm run eval:crewmate:e2e
```

The e2e gate fails loudly if replies don't arrive, chatter isn't silent,
or a reply ever claims to have changed the schedule.

## 5. Enable for the real pilot group (production)

Only after the staging e2e gate passes:

```bash
npm run link:prod
supabase secrets set TOGETHER_API_KEY=<key>   # production project
supabase db query --linked -c "update public.groups set crewmate_enabled = true where id = 'c1000000-0000-4000-8000-000000000001';"
```

Parents immediately get: the pinned "Crewmate AI" entry in the new-chat
sheet (private threads, triage-free), and answers in every existing thread
where triage classifies a schedule question. Nothing else changes.

## 6. Operating notes

- **Disabling** (any incident): flip the flag off — invocations stop
  instantly and cost goes to zero. `supabase db query --linked -c "update
  public.groups set crewmate_enabled = false where id = '<group>';"`
- **Budget**: `crewmate_monthly_token_budget` (default 2,000,000
  tokens/month) is checked inline on every run; when exceeded, runs are
  recorded as `skipped_budget` and the agent goes quiet. Coordinators can
  raise the cap in SQL; Phase 4 adds UI + automated enforcement.
- **Observability**: every run is a `crewmate_runs` row (status, tokens,
  tools used, outcome). Coordinator-readable via RLS:

  ```sql
  select status, count(*), sum(triage_tokens_in+triage_tokens_out+planner_tokens_in+planner_tokens_out) as tokens
  from crewmate_runs group by status;
  ```
- **Rollback**: the flag is the rollback. The schema is additive; no
  migration-down is needed to disable.
- **What Phase 1 never does**: no proposals, no schedule-table writes, no
  in-thread consent detection, no proactive coverage posts. Those land in
  Phases 2–3 per the requirements doc.