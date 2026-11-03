-- New products and their physical-stock routes are one atomic catalog change.
-- Never infer another product's owner or silently merge similar SKU spellings.
create function public.initialize_new_product_stock_route()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare
  v_key text := pg_catalog.regexp_replace(pg_catalog.upper(pg_catalog.btrim(coalesce(new.sku,''))), '[^A-Z0-9]', '', 'g');
begin
  if v_key='' then v_key:=pg_catalog.replace(new.id::text,'-',''); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stock-route-key:'||v_key,0));
  if exists(select 1 from public.inventory_stock_routes where operational_key=v_key) then
    raise exception 'This product code matches an existing inventory identity. Use the existing product or review its mapping; no product or stock was created.';
  end if;
  insert into public.inventory_stock_routes(product_id,stock_product_id,operational_key)
  values(new.id,new.id,v_key);
  return new;
end;
$$;
revoke all on function public.initialize_new_product_stock_route() from public,anon,authenticated;
grant execute on function public.initialize_new_product_stock_route() to service_role;
create trigger products_initialize_stock_route
after insert on public.products
for each row execute function public.initialize_new_product_stock_route();

-- The confirmed incident: this newly created, distinct product has zero ledger
-- history. Repair only its missing metadata; never recalculate historical owners.
do $$
declare v_product uuid;
begin
  select p.id into v_product from public.products p
  where p.sku='2PAS-10' and not exists(select 1 from public.inventory_stock_routes r where r.product_id=p.id);
  if v_product is not null then
    if exists(select 1 from public.inventory_transactions where product_id=v_product)
      or exists(select 1 from public.inventory_stock_routes where operational_key='2PAS10') then
      raise exception '2PAS-10 stock identity needs review; routing repair aborted.';
    end if;
    insert into public.inventory_stock_routes(product_id,stock_product_id,operational_key)
    values(v_product,v_product,'2PAS10');
    insert into public.audit_log(entity_type,entity_id,action,details)
    values('product',v_product,'STOCK_ROUTE_INITIALIZED',
      pg_catalog.jsonb_build_object('reason','Repair missing route after Add Product; no inventory quantities changed','stock_product_id',v_product,'operational_key','2PAS10','repair_key','new-product-stock-route-20261103-v1'));
  end if;
end;
$$;
