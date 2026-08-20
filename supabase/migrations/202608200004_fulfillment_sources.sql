alter table public.shipping_order_lines
  add column if not exists fulfillment_source text,
  add column if not exists fulfillment_supplier text,
  add column if not exists fulfillment_reference text,
  add column if not exists fulfillment_tracking text,
  add column if not exists fulfillment_notes text;

alter table public.shipping_order_lines
  drop constraint if exists shipping_order_lines_fulfillment_source_check;

alter table public.shipping_order_lines
  add constraint shipping_order_lines_fulfillment_source_check
  check (fulfillment_source is null or fulfillment_source in ('WAREHOUSE', 'CONTAINER', 'DROPSHIP', 'OTHER'));
