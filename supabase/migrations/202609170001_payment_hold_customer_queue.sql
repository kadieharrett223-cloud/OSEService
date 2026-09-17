-- A payment-held order reserves its normal place in the customer queue, but
-- cannot be physically fulfilled until QuickBooks reports a zero balance.
alter table public.shipping_orders
  add column if not exists payment_hold boolean not null default false,
  add column if not exists payment_hold_reason text,
  add column if not exists payment_hold_set_at timestamptz;

create index if not exists shipping_orders_payment_hold_idx
  on public.shipping_orders (payment_hold)
  where payment_hold = true;

comment on column public.shipping_orders.payment_hold is
  'Manual exception: reserve customer-list position before payment, but block shipment until the linked QBO invoice is Paid.';

create or replace function public.guard_payment_hold_order_shipment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.shipping_orders o
    left join public.qbo_invoices i on i.id = o.source_invoice_id
    where o.id = new.shipping_order_id
      and o.payment_hold = true
      and coalesce(upper(i.payment_status), '') <> 'PAID'
  ) then
    raise exception 'Payment hold: QuickBooks must show this invoice as Paid before shipment can be completed';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_payment_hold_order_shipment on public.order_shipments;
create trigger guard_payment_hold_order_shipment
before insert or update of shipping_order_id on public.order_shipments
for each row execute function public.guard_payment_hold_order_shipment();
