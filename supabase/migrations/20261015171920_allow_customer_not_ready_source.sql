-- Match the existing fulfillment-source dropdown. No order or stock data is changed.
set local lock_timeout = '5s';

alter table public.shipping_order_lines
  drop constraint shipping_order_lines_fulfillment_source_check;

alter table public.shipping_order_lines
  add constraint shipping_order_lines_fulfillment_source_check
  check (fulfillment_source is null or fulfillment_source in (
    'WAREHOUSE', 'DROPSHIP', 'OTHER', 'CUSTOMER_NOT_READY'
  ));
