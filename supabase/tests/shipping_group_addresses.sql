-- Transactional integration check: all synthetic invoice addresses are rolled back.
begin;
set local role service_role;
do $test$
declare invoice_id uuid; before_orders jsonb; after_orders jsonb;
begin
  select i.id into strict invoice_id from public.qbo_invoices i
  where exists(select 1 from public.shipping_orders o where o.source_invoice_id=i.id) order by i.id limit 1;
  select jsonb_agg(to_jsonb(o)-'updated_at'-'delivery_address'-'delivery_city'-'delivery_state'-'delivery_postal_code'-'delivery_country' order by id)
    into before_orders from public.shipping_orders o where source_invoice_id=invoice_id;
  update public.qbo_invoices set raw_payload=jsonb_set(coalesce(raw_payload,'{}'::jsonb),'{ShipAddr}',
    '{"Line1":"100 Verification Street","Line2":"Sioux Falls, SD 57103"}'::jsonb)
    where id=invoice_id;
  if exists(select 1 from public.shipping_orders where source_invoice_id=invoice_id
    and (delivery_city is distinct from 'Sioux Falls' or delivery_state is distinct from 'SD' or delivery_postal_code is distinct from '57103')) then
    raise exception 'Invoice address update failed';
  end if;
  -- Exercise the source-invoice/order creation branch without creating an order.
  update public.shipping_orders set source_invoice_id=source_invoice_id where source_invoice_id=invoice_id;
  if exists(select 1 from public.shipping_orders where source_invoice_id=invoice_id and delivery_state is distinct from 'SD') then
    raise exception 'Order source link address update failed';
  end if;
  update public.qbo_invoices set raw_payload=raw_payload-'ShipAddr' where id=invoice_id;
  if exists(select 1 from public.shipping_orders where source_invoice_id=invoice_id
    and (delivery_address is not null or delivery_city is not null or delivery_state is not null or delivery_postal_code is not null)) then
    raise exception 'Missing address retained stale data or default fallback';
  end if;
  select jsonb_agg(to_jsonb(o)-'updated_at'-'delivery_address'-'delivery_city'-'delivery_state'-'delivery_postal_code'-'delivery_country' order by id)
    into after_orders from public.shipping_orders o where source_invoice_id=invoice_id;
  if before_orders is distinct from after_orders then raise exception 'Non-address order data changed'; end if;
end;
$test$;
rollback;
