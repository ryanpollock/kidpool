-- Riding buddy: optional preference for a child to ride with a specific friend.
-- Lightweight single-column approach. App-level enforces same-group + different-household.
-- FK on delete set null so deactivating a buddy clears the preference gracefully.

alter table public.children
  add column preferred_buddy_child_id uuid;

alter table public.children
  add constraint children_buddy_not_self
  check (preferred_buddy_child_id is null or preferred_buddy_child_id <> id);

alter table public.children
  add constraint children_buddy_fk
  foreign key (preferred_buddy_child_id) references public.children(id)
  on delete set null;