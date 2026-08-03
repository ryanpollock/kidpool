-- Priority child flag: when true, the scheduling algorithm guarantees
-- this child a seat on any trip they need a ride for, as long as any
-- eligible driver has available capacity. Priority wins the seat over
-- non-priority riders, including over another child's buddy-in-car
-- advantage. Sara's own preferred_buddy_child_id still works for
-- co-placement once she is assigned to a car.
--
-- Default false so all existing children are unchanged by this migration.
-- The flag is set per child via a follow-up data migration (see
-- 202608030006_set_priority_sara.sql). No UI toggle exists yet; it is
-- managed via SQL until a coordinator-screen switch is added.

alter table public.children
  add column if not exists is_priority boolean not null default false;

comment on column public.children.is_priority is
  'If true, scheduling algorithm guarantees this child a seat whenever one is available on a trip they need a ride for';