# Supabase foundation

This directory is the source of truth for the carpool database.

## Exchange 1 contents

- `migrations/202607300001_exchange_1_foundation.sql` creates the relational
  schema, constraints, onboarding functions, driver-confirmation transaction,
  audit log, and row-level security policies.
- `seed.sql` creates the single pilot carpool group without manufacturing Auth
  users. Parent profiles and households are created through sign-in and
  onboarding.

The browser receives only the Supabase project URL and publishable key. A
service-role or secret key must never be stored in a `VITE_*` variable.

## Exchange 2 status

The hosted project is connected and Google Auth is enabled. The application now:

- restores a persisted Supabase session;
- keeps signed-out visitors outside the carpool UI;
- starts Google OAuth and handles canceled or failed sign-in;
- confirms the signed-in parent's full display name;
- creates a household and returns its one-time join code, or joins a household
  with a code; and
- provides explicit sign-out from the household profile screen.

Before production deployment, add the final deployed app URL to the Supabase
Auth redirect allow list. The Google OAuth client should also move to a
carpool-specific Google Cloud project so its consent-screen branding is not
shared with another application.
