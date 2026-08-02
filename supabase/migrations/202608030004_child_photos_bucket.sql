-- Child photos bucket: public-read, household-only write.
-- Object path convention: <household_id>/<child_id>.<ext>
-- The first path segment (foldername(name))[1] is the household_id,
-- which we validate against is_household_member.

insert into storage.buckets (id, name, public)
values ('child-photos', 'child-photos', true)
on conflict (id) do nothing;

-- Public read: anyone can view child photos (no auth required).
-- This lets <img> tags load without a signed URL.
create policy "child-photos-public-read"
  on storage.objects for select
  using (bucket_id = 'child-photos');

-- Household members can insert/update objects in their household folder.
create policy "child-photos-household-write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'child-photos'
    and (storage.foldername(name))[1] in (
      select h.id::text from public.households h
      where public.is_household_member(h.id)
    )
  );

create policy "child-photos-household-update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'child-photos'
    and (storage.foldername(name))[1] in (
      select h.id::text from public.households h
      where public.is_household_member(h.id)
    )
  )
  with check (
    bucket_id = 'child-photos'
    and (storage.foldername(name))[1] in (
      select h.id::text from public.households h
      where public.is_household_member(h.id)
    )
  );