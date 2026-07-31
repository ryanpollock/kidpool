-- Add default drive preferences column to profiles.
-- Stores a JSON array of 10 entries (5 days × 2 directions) representing
-- the driver's standard weekly driving availability.
-- Auto-populates new weeks via the app's applyDefaultDrivePreferences method.
-- No new RLS needed — profiles already has profile_id = auth.uid() policy.

alter table public.profiles
  add column if not exists default_drive_preferences jsonb default '[]'::jsonb;