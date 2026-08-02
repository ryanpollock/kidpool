-- Child photos: optional photo_url per child for the drive detail page.
-- Stored as a URL — either a Supabase Storage public URL (real uploads)
-- or a Dicebear avatar URL (demo/seed data). No RLS change needed;
-- children_update_household already allows household members to update
-- any column.

alter table public.children
  add column if not exists photo_url text;