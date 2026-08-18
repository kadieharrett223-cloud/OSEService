alter table public.shipping_orders
  add column if not exists first_payment_at timestamptz;

create index if not exists idx_shipping_orders_first_payment_at
  on public.shipping_orders(first_payment_at asc nulls last);
