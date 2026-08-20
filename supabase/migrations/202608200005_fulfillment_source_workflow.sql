alter table public.shipping_order_lines
  drop constraint if exists shipping_order_lines_fulfillment_source_check;

alter table public.shipping_order_lines
  add constraint shipping_order_lines_fulfillment_source_check
  check (fulfillment_source is null or fulfillment_source in ('WAREHOUSE', 'DROPSHIP', 'OTHER')) not valid;

alter table public.fulfillments
  drop constraint if exists fulfillments_fulfillment_type_check;

alter table public.fulfillments
  add constraint fulfillments_fulfillment_type_check
  check (fulfillment_type in ('SHIPMENT', 'PICKUP', 'DROPSHIP', 'OTHER'));
