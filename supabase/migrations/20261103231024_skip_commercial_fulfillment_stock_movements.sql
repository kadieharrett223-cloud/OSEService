-- Commercial completion is not a warehouse movement. This guard is ahead of
-- stock routing so all shipment callers share the same final boundary.
create function public.skip_commercial_fulfillment_stock_movement()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare v_commercial boolean;
begin
  if new.bucket<>'ON_FLOOR' or new.source_type<>'FULFILLMENT' then return new; end if;
  select exists(
    select 1 from public.products p
    cross join lateral (values(p.sku),(p.canonical_name)) labels(value)
    where p.id=new.product_id and pg_catalog.regexp_replace(pg_catalog.upper(coalesce(labels.value,'')),'[^A-Z0-9]','','g')
      in ('INSTALL','INSTALLATION','INSTALLATIONSERVICE','SERVICE','SHIPPING','SHIPPINGCHARGE','FREIGHT','FREIGHTCHARGE','DELIVERY','DELIVERYCHARGE','DISCOUNT','SALESTAX','TAXADJUSTMENT')
  ) into v_commercial;
  if not v_commercial then return new; end if;
  insert into public.audit_log(entity_type,entity_id,action,details)
  values('product',new.product_id,'NON_INVENTORY_STOCK_WRITE_SKIPPED',
    pg_catalog.jsonb_build_object('source_event_key',new.source_event_key,'shipping_order_line_id',new.shipping_order_line_id,
      'attempted_delta',new.delta,'reason','Commercial service/charge completion has no physical stock movement'));
  return null;
end;
$$;
revoke all on function public.skip_commercial_fulfillment_stock_movement() from public,anon,authenticated;
grant execute on function public.skip_commercial_fulfillment_stock_movement() to service_role;
create trigger inventory_transactions_00_skip_commercial_fulfillment
before insert on public.inventory_transactions
for each row execute function public.skip_commercial_fulfillment_stock_movement();
