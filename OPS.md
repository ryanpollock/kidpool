# Operations Guide — Midtown Carpool

Production operations runbook for the Clarendon Presidio carpool pilot.

## 1. Environment

| Component | Value |
|---|---|
| Supabase project | `ujcrnrcgbvzyqosykkjy` (https://ujcrnrcgbvzyqosykkjy.supabase.co) |
| Supabase region | U.S. |
| Frontend hosting | Vercel (project `kidpool`, URL `https://kidpool-sf.vercel.app`) |
| Auth provider | Google OAuth (Supabase Auth) |
| Edge Functions | `generate-schedule` (Supabase Functions, Deno) |
| Timezone | `America/Los_Angeles` for all carpool scheduling |

## 2. Database backup and recovery

### Daily backups
Supabase Pro includes daily automated backups. Verify backup status:
1. Open the Supabase dashboard → Project `ujcrnrcgbvzyqosykkjy`.
2. Go to **Database → Backups**.
3. Confirm the latest backup timestamp is within the last 24 hours.

### Restore from backup
1. Supabase dashboard → **Database → Backups**.
2. Select the target backup point.
3. Click **Restore**. This creates a new branch or replaces the current project data depending on the chosen option.
4. After restore, verify the app loads and a test household can sign in.

### Point-in-time recovery (PITR)
Supabase Pro supports PITR. Use it if a bad migration or data corruption needs to be rolled back to a specific timestamp, not just the daily snapshot.

## 3. Administrator access

The following people have admin access to the Supabase project:
- Project owner: Ryan Pollock (Supabase dashboard login)
- Any additional Supabase dashboard members listed in **Project Settings → Members**

Admins can:
- Run SQL via the SQL Editor.
- Manage auth users.
- Deploy/redeploy Edge Functions.
- View and restore backups.
- Manage environment secrets (Supabase service-role key, Resend API key).

Admins should NOT:
- Put the service-role key in any `VITE_*` variable or client-side code.
- Modify RLS policies without running the security test suite afterward.
- Delete audit_events rows during normal operation.

## 4. Coordinator role assignment

A user becomes a coordinator via SQL (no UI for this in the MVP):

```sql
-- Find the user's profile id
select id, full_name from public.profiles where full_name ilike '%Parent Name%';

-- Assign coordinator role
update public.memberships
set role = 'coordinator'
where profile_id = '<profile-id-from-query-above>'
  and status = 'active';
```

To revoke:
```sql
update public.memberships
set role = 'member'
where profile_id = '<profile-id>';
```

Only coordinators can:
- Create weeks and trips.
- Generate draft schedules.
- Publish schedules.
- View the coordinator coverage overview.

## 5. Edge Function deployment

The `generate-schedule` Edge Function runs on Supabase Functions (Deno).

```bash
supabase functions deploy generate-schedule --project-ref ujcrnrcgbvzyqosykkjy
```

Required Supabase secrets (set in dashboard → **Project Settings → Edge Functions → Secrets**):
- `SUPABASE_URL` — auto-set by Supabase.
- `SUPABASE_ANON_KEY` — auto-set by Supabase.

No additional secrets required for the MVP. The function authenticates via the caller's JWT.

## 6. Frontend deployment (Vercel)

### Prerequisites
- `.env.local` contains `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable/browser-safe values only).
- `npm run build` succeeds.
- `vercel.json` is configured with `outputDirectory: "dist/client"` and SPA rewrite.
- Vercel project is linked (`vercel link`) and has production env vars set (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`).

### Deploy steps
1. `vercel --prod --yes` — builds and deploys to production.
2. The production alias is `https://kidpool-sf.vercel.app`.
3. After the first deploy, verify Google OAuth redirect URLs in Supabase dashboard → **Authentication → URL Configuration** include the Vercel URL.

### Redeploy after code changes
```bash
vercel --prod --yes
```

### Production env values
The build bakes in `VITE_*` env vars at compile time. Vercel reads these from the project's environment variables. To update:
```bash
vercel env rm VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_URL production
vercel --prod --yes
```

Never put `SUPABASE_SERVICE_ROLE_KEY` or any secret in a `VITE_*` variable. Browser-side code can only use the publishable anon key; all authorization is enforced by RLS.

## 7. Emergency fallback procedure

If the app is unavailable or scheduling fails:

1. **Coordinator posts the schedule manually.** Use the last published schedule from the Week screen (or the Supabase dashboard → Table editor → `schedule_versions` + `driver_assignments` + `rider_assignments`) and share it via the existing parent group chat or email.

2. **If Supabase is down:**
   - Check status at https://status.supabase.com.
   - If auth is broken, sign-in will fail for all users. Wait for recovery.
   - If only the Edge Function fails, coordinators cannot generate new drafts but previously published schedules remain visible.

3. **If the frontend is down:**
   - The Supabase database and Edge Functions remain operational.
   - Coordinators can query the database directly via the SQL Editor to read or export the current schedule.

4. **If a bad migration is applied:**
   - Use PITR (see section 2) to roll back to before the migration.
   - Re-apply only the correct migrations via `supabase db query --linked -f <file>`.

## 8. Audit trail

All significant actions are recorded in `audit_events`:

| Action | Entity | Recorded by |
|---|---|---|
| `household_created` | household | `create_household_with_membership` RPC |
| `driver_assignment_responded` | driver_assignment | `respond_to_driver_assignment` RPC |
| `week_created` | week | Repository (client-side) |
| `checkin_submitted` | weekly_checkin | Repository |
| `checkin_reopened` | weekly_checkin | Repository |
| `child_added` / `child_updated` / `child_removed` | child | Repository |
| `vehicle_added` / `vehicle_updated` | vehicle | Repository |
| `schedule_generated` | schedule_version | Edge Function |
| `schedule_published` | schedule_version | Repository |

Audit events are best-effort: a failed audit insert does not block the user's primary action. To query the audit trail:

```sql
select occurred_at, action, entity_type, entity_id, details
from public.audit_events
where group_id = '<group-uuid>'
order by occurred_at desc
limit 100;
```

## 9. Privacy and retention

- Children are parent-managed records, never user accounts.
- No live location is stored.
- No emergency contact details are stored in the MVP.
- Household data export: query all tables where `household_id = '<uuid>'`.
- Household data deletion: set `memberships.status = 'removed'` and `children.active = false`. The household record is retained for audit history.
- End-of-school-year archival: export all tables, then delete child and vehicle records. Retain `audit_events` for one school year, then delete on a documented schedule.
- A plain-language privacy notice should be shared with participating families before the pilot.

## 10. End-to-end pilot rehearsal

Before the pilot, run the full workflow with at least 2 real Google accounts:

1. **Setup (one-time):** Assign coordinator role via SQL (section 4). Have each parent sign in with Google OAuth and create/join a household.
2. **Household setup:** Each parent adds their children and a vehicle in Account.
3. **Week creation:** Coordinator opens Cover tab → "Create next week".
4. **Household check-in:** Each parent opens Plan tab → toggles rides per child → sets drive preference → submits.
5. **Draft generation:** Coordinator opens Cover tab → "Generate draft schedule".
6. **Driver confirmation:** Each assigned driver opens Home → "Confirm all drives" (or reviews individually with optional decline reason).
7. **Publication:** Coordinator opens Cover tab → "Publish schedule".
8. **Verification:** All parents open Week tab → see the published roster with driver, vehicle, and riders per trip.

If any step fails, check:
- Browser console for client-side errors.
- Supabase dashboard → **Logs → Edge Functions** for `generate-schedule` errors.
- Supabase dashboard → **Logs → Auth** for sign-in issues.
- `audit_events` table for action-level debugging.