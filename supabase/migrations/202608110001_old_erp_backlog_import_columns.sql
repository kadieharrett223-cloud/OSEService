-- Add source-tracking/idempotency fields for one-time OLD_ERP backlog import.
-- This is additive and safe for existing order workflows.

alter table public.shipping_orders
  add column if not exists source_system text,
  add column if not exists source_record_id text,
  add column if not exists source_key text,
  add column if not exists legacy_customer_name text;

alter table public.shipping_order_lines
  add column if not exists source_system text,
  add column if not exists source_record_id text,
  add column if not exists source_key text,
  add column if not exists legacy_item_code text,
  add column if not exists legacy_matched_item_code text,
  add column if not exists legacy_queue_status text,
  add column if not exists legacy_warehouse_status text,
  add column if not exists legacy_priority_flag text,
  add column if not exists legacy_fulfillment_method text,
  add column if not exists legacy_expected_by date,
  add column if not exists legacy_qbo_shipping_method text,
  add column if not exists legacy_floor_assignment jsonb;

create unique index if not exists idx_shipping_orders_source_key_unique
  on public.shipping_orders(source_key)
  where source_key is not null;

create unique index if not exists idx_shipping_order_lines_source_key_unique
  on public.shipping_order_lines(source_key)
  where source_key is not null;
