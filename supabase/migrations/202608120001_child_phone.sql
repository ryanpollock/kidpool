-- Add a phone column to children so parents can provide a direct
-- contact for their kid (e.g., a kid's cell phone). Providing the
-- number is the opt-in: it is only surfaced to the driver assigned
-- to a drive that includes this child (DriveDetailScreen).
-- No share_phone toggle — visibility is drive-scoped, not group-wide.
alter table public.children
  add column if not exists phone text;