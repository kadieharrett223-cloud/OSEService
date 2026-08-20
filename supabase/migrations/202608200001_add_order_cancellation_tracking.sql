-- Add cancellation tracking to shipping_orders
-- Supports both user-initiated cancellations and automatic QBO void transitions

alter table public.shipping_orders
  add column if not exists cancellation_status varchar default null, -- null, 'CANCELLED'
  add column if not exists cancellation_reason varchar default null, -- e.g., 'Voided in QuickBooks'
  add column if not exists cancelled_at timestamptz default null;

create index if not exists shipping_orders_cancellation_status_idx on public.shipping_orders(cancellation_status);
