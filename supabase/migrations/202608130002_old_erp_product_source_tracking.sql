-- Add source-tracking metadata for OLD_ERP product imports.
-- These columns are nullable and do not classify existing rows retroactively.

alter table public.products
  add column if not exists source_system text,
  add column if not exists source_record_id text,
  add column if not exists source_key text;

create unique index if not exists idx_products_source_key_unique
  on public.products(source_key)
  where source_key is not null;

create index if not exists idx_products_source_record
  on public.products(source_system, source_record_id);
