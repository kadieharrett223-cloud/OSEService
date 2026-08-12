-- Preserve Azure backlog assignment history without creating live inventory allocations.

alter table public.shipping_order_lines
  add column if not exists legacy_container_assignment text,
  add column if not exists suggested_assignment_source text
    check (suggested_assignment_source in ('UNASSIGNED', 'FLOOR', 'CONTAINER')),
  add column if not exists suggested_container_id uuid references public.containers(id) on delete set null;

create index if not exists idx_shipping_order_lines_suggested_container
  on public.shipping_order_lines(suggested_container_id)
  where suggested_container_id is not null;