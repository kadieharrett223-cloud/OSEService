-- Product-specific fulfillment queue controls.
-- Automatic positions remain the default; employees can override with a required reason.

alter table public.shipping_order_lines
  add column if not exists queue_position_override integer,
  add column if not exists queue_position_override_reason text,
  add column if not exists queue_position_override_at timestamptz,
  add column if not exists queue_position_override_by uuid references public.access_users(id) on delete set null;

create index if not exists idx_shipping_order_lines_product_queue
  on public.shipping_order_lines(product_id, approval_status, fulfillment_status, queue_position_start);

create index if not exists idx_shipping_order_lines_queue_override
  on public.shipping_order_lines(product_id, queue_position_override)
  where queue_position_override is not null;
