-- Add source-tracking/idempotency fields for one-time OLD_ERP container import.
-- This is additive and safe for existing container workflows.

alter table public.containers
  add column if not exists source_system text,
  add column if not exists source_record_id text,
  add column if not exists source_key text;

-- Keep source key idempotent when present.
create unique index if not exists idx_containers_source_key_unique
  on public.containers(source_key)
  where source_key is not null;

alter table public.container_lines
  add column if not exists product_mapping_status text not null default 'MAPPED'
    check (product_mapping_status in ('MAPPED', 'UNMAPPED', 'REVIEW')),
  add column if not exists source_line_ref text;

create index if not exists idx_containers_source_record
  on public.containers(source_system, source_record_id);
