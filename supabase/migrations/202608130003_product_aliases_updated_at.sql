-- Repair the existing product_aliases updated_at trigger contract.
-- The base inventory migration creates an updated_at trigger for product_aliases,
-- but product_aliases did not originally include the column.

alter table public.product_aliases
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_product_aliases_updated_at
  on public.product_aliases(updated_at desc);
