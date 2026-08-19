alter table public.shipping_orders
  add column if not exists duplicate_of_order_id uuid references public.shipping_orders(id) on delete restrict;

create index if not exists shipping_orders_duplicate_of_order_id_idx
  on public.shipping_orders(duplicate_of_order_id)
  where duplicate_of_order_id is not null;
