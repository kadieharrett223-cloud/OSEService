-- Invoice-specific delivery metadata only. Never copy a customer default/BillAddr.
set local lock_timeout = '5s';
alter table public.shipping_orders
  add column delivery_address jsonb,
  add column delivery_city text,
  add column delivery_state text,
  add column delivery_postal_code text,
  add column delivery_country text;

create function public.sync_order_invoice_delivery_address()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare address jsonb;
begin
  if tg_table_name = 'shipping_orders' then
    select raw_payload->'ShipAddr' into address from public.qbo_invoices where id=new.source_invoice_id;
    if jsonb_typeof(address) is distinct from 'object' then address := null; end if;
    new.delivery_address := address;
    new.delivery_city := nullif(trim(address->>'City'),'');
    new.delivery_state := nullif(upper(trim(address->>'CountrySubDivisionCode')),'');
    new.delivery_postal_code := nullif(trim(address->>'PostalCode'),'');
    new.delivery_country := nullif(upper(trim(address->>'Country')),'');
  else
    address := new.raw_payload->'ShipAddr';
    if jsonb_typeof(address) is distinct from 'object' then address := null; end if;
    update public.shipping_orders set
      delivery_address=address,
      delivery_city=nullif(trim(address->>'City'),''),
      delivery_state=nullif(upper(trim(address->>'CountrySubDivisionCode')),''),
      delivery_postal_code=nullif(trim(address->>'PostalCode'),''),
      delivery_country=nullif(upper(trim(address->>'Country')),'')
    where source_invoice_id=new.id and delivery_address is distinct from address;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_order_invoice_delivery_address() from public, anon, authenticated;

create trigger shipping_order_invoice_delivery_address
before insert or update of source_invoice_id on public.shipping_orders
for each row execute function public.sync_order_invoice_delivery_address();
create trigger qbo_invoice_delivery_address
after insert or update of raw_payload on public.qbo_invoices
for each row execute function public.sync_order_invoice_delivery_address();

-- Populate metadata from existing invoice snapshots without running QBO/order/stock workflows.
update public.shipping_orders o set
  delivery_address=i.raw_payload->'ShipAddr',
  delivery_city=nullif(trim(i.raw_payload->'ShipAddr'->>'City'),''),
  delivery_state=nullif(upper(trim(i.raw_payload->'ShipAddr'->>'CountrySubDivisionCode')),''),
  delivery_postal_code=nullif(trim(i.raw_payload->'ShipAddr'->>'PostalCode'),''),
  delivery_country=nullif(upper(trim(i.raw_payload->'ShipAddr'->>'Country')),'')
from public.qbo_invoices i
where o.source_invoice_id=i.id and jsonb_typeof(i.raw_payload->'ShipAddr')='object';
