-- Customer readiness is independent of fulfillment, stock and payment.
alter table public.shipping_order_lines
  add column customer_queue_paused boolean not null default false,
  add column customer_queue_pause_reason text;
comment on column public.shipping_order_lines.customer_queue_paused is
  'Temporary Customer List exclusion only. Does not fulfill, cancel, release allocations or change inventory.';
