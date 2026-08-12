-- Parent avatars bucket: public-read, owner-only write.
-- Object path convention: <profile_id>.<ext>
-- RLS keys on auth.uid() so only the profile owner can upload/replace
-- their own avatar (unlike child-photos which keys on household membership).

insert into storage.buckets (id, name, public)
values ('parent-avatars', 'parent-avatars', true)
on conflict (id) do nothing;

-- Public read: anyone can view parent avatars (no auth required),
-- so <img> tags load without a signed URL — matches child-photos.
create policy "parent-avatars-public-read"
  on storage.objects for select
  using (bucket_id = 'parent-avatars');

-- Owner can insert their own avatar object (path = <profile_id>.<ext>).
create policy "parent-avatars-owner-insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'parent-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owner can update their own avatar object.
create policy "parent-avatars-owner-update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'parent-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'parent-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );