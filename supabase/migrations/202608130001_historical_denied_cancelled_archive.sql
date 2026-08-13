-- Historical denied/cancelled archive ingestion tables.
-- This schema is isolated from active shipping and inventory workflows.

create table if not exists public.order_history_reason_events_raw (
  id uuid primary key default gen_random_uuid(),
  import_batch_id text not null,
  source_system text not null default 'OLD_ERP_COSMOS',
  source_container text not null default 'InventoryAdjustments',
  source_id text not null,
  invoice_number text not null,
  invoice_number_normalized text not null,
  item_code text not null,
  item_code_normalized text not null,
  reason_category text not null check (reason_category in ('setup_rollback', 'cancel_deny_rollback')),
  reason text not null,
  reason_normalized text not null,
  actor text,
  adjusted_at timestamptz,
  created_at timestamptz,
  raw_payload jsonb,
  imported_at timestamptz not null default now()
);

create table if not exists public.order_history_reason_rollups (
  id uuid primary key default gen_random_uuid(),
  reason_category text not null check (reason_category in ('setup_rollback', 'cancel_deny_rollback')),
  invoice_number_normalized text not null,
  item_code_normalized text not null,
  reason_normalized text not null,
  canonical_invoice_number text not null,
  canonical_item_code text not null,
  canonical_reason text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count integer not null check (occurrence_count >= 1),
  actors text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint order_history_reason_rollups_unique
    unique (reason_category, invoice_number_normalized, item_code_normalized, reason_normalized)
);

create index if not exists idx_order_history_reason_events_raw_category
  on public.order_history_reason_events_raw(reason_category, created_at desc);

create index if not exists idx_order_history_reason_events_raw_lookup
  on public.order_history_reason_events_raw(invoice_number_normalized, item_code_normalized, reason_category);

create index if not exists idx_order_history_reason_rollups_category
  on public.order_history_reason_rollups(reason_category, last_seen_at desc);

create trigger order_history_reason_rollups_updated_at
before update on public.order_history_reason_rollups
for each row execute function public.update_updated_at_column();

alter table public.order_history_reason_events_raw enable row level security;
alter table public.order_history_reason_rollups enable row level security;

create policy "order_history_reason_events_raw_read_all" on public.order_history_reason_events_raw
for select to authenticated
using (true);

create policy "order_history_reason_events_raw_write_authenticated" on public.order_history_reason_events_raw
for all to authenticated
using (true)
with check (true);

create policy "order_history_reason_rollups_read_all" on public.order_history_reason_rollups
for select to authenticated
using (true);

create policy "order_history_reason_rollups_write_authenticated" on public.order_history_reason_rollups
for all to authenticated
using (true)
with check (true);