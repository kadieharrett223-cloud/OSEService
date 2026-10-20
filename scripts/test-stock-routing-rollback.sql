-- Synthetic integration test only. The entire transaction is rolled back.
begin;
set local role service_role;
set local statement_timeout='15s';
do $$
declare
 owner_id uuid:=gen_random_uuid(); alias_id uuid:=gen_random_uuid(); extra_id uuid:=gen_random_uuid();
 order_id uuid:=gen_random_uuid(); line_id uuid:=gen_random_uuid(); untouched_id uuid:=gen_random_uuid();
 shipment_id uuid; retry_id uuid; request_id uuid:=gen_random_uuid(); key text:='TESTSTOCK'||upper(replace(gen_random_uuid()::text,'-',''));
 floor_qty numeric; result jsonb; before_count bigint;
begin
 insert into public.products(id,sku,canonical_name) values(owner_id,key,'Synthetic stock routing test'),(alias_id,'HK-'||key,'Synthetic alias'),(extra_id,key||'PART','Synthetic separate part');
 insert into public.inventory_stock_routes(product_id,stock_product_id,operational_key) values(owner_id,owner_id,key),(alias_id,owner_id,key);
 insert into public.shipping_orders(id,order_number) values(order_id,key);
 insert into public.shipping_order_lines(id,shipping_order_id,product_id,ordered_qty,approved_qty,approval_status,fulfillment_source)
 values(line_id,order_id,alias_id,3,3,'APPROVED','WAREHOUSE'),(untouched_id,order_id,extra_id,4,4,'APPROVED','WAREHOUSE');
 insert into public.inventory_transactions(product_id,bucket,delta,before_qty,after_qty,source_type,source_event_key,reason,created_at)
 values(owner_id,'ON_FLOOR',7,0,7,'RECOUNT',key||':count','Synthetic opening count',now()-interval '7 days');

 shipment_id:=public.complete_order_shipment(order_id,now(),'TEST',null,'Synthetic rollback only',key||':shipment',jsonb_build_array(jsonb_build_object('line_id',line_id,'quantity',2)));
 select coalesce(sum(delta),0) into floor_qty from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR';
 if floor_qty<>5 then raise exception 'Shipment did not use owner ledger: %',floor_qty; end if;
 if exists(select 1 from public.inventory_transactions where product_id=alias_id) then raise exception 'Shadow ledger written'; end if;
 if (select fulfilled_qty from public.shipping_order_lines where id=untouched_id)<>0 then raise exception 'Unselected product fulfilled'; end if;
 if not exists(select 1 from public.inventory_transactions where stock_requested_product_id=alias_id and product_id=owner_id and delta=-2 and before_qty=7 and after_qty=5) then raise exception 'Missing routing trace'; end if;

 retry_id:=public.complete_order_shipment(order_id,now(),'TEST',null,null,key||':shipment',jsonb_build_array(jsonb_build_object('line_id',line_id,'quantity',2)));
 if retry_id<>shipment_id or (select count(*) from public.inventory_transactions where product_id=owner_id and source_type='FULFILLMENT')<>1 then raise exception 'Retry duplicated deduction'; end if;
 perform public.edit_order_shipment(shipment_id,order_id,now(),'TEST',null,'Synthetic edit',jsonb_build_array(jsonb_build_object('line_id',line_id,'quantity',1)),null);
 if (select sum(delta) from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR')<>6 then raise exception 'Edit reversal used wrong ledger'; end if;
 insert into public.inventory_transactions(product_id,bucket,delta,source_type,source_event_key,reason)
 values(alias_id,'ON_FLOOR',2,'CONTAINER_RECEIVED',key||':receipt','Synthetic receipt');
 if (select sum(delta) from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR')<>8 then raise exception 'Receipt used wrong ledger'; end if;

 select count(*) into before_count from public.inventory_transactions where product_id in (owner_id,alias_id) and bucket='ON_FLOOR';
 result:=public.recount_inventory_stock_group(array[owner_id,alias_id],array[owner_id],owner_id,8,5,before_count,request_id,'Synthetic test',null,'Synthetic recount');
 if (select sum(delta) from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR')<>5 then raise exception 'Recount failed: %',result; end if;
 perform public.recount_inventory_stock_group(array[owner_id,alias_id],array[owner_id],owner_id,8,5,before_count,request_id,'Synthetic test',null,'Synthetic recount');
 if (select sum(delta) from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR')<>5 then raise exception 'Recount retry changed stock'; end if;

 begin
   perform public.complete_order_shipment(order_id,now()-interval '20 days','TEST',null,null,key||':historical',jsonb_build_array(jsonb_build_object('line_id',line_id,'quantity',1)));
   raise exception 'Expected historical shipment guard';
 exception when others then
   if sqlerrm not like 'Shipment predates the latest stock recount%' then raise; end if;
 end;
 if (select count(*) from public.order_shipments where shipping_order_id=order_id)<>1 then raise exception 'Rejected shipment was not atomic'; end if;
 -- An unbound manufacturer-prefixed catalog copy joins the established owner.
 declare new_copy uuid:=gen_random_uuid(); begin
   insert into public.products(id,sku,canonical_name) values(new_copy,'FB-'||key,'Synthetic new catalog copy');
   insert into public.inventory_transactions(product_id,bucket,delta,source_type,source_event_key,reason) values(new_copy,'ON_FLOOR',1,'CONTAINER_RECEIVED',key||':new-copy','Synthetic new receipt');
   if (select stock_product_id from public.inventory_stock_routes where product_id=new_copy)<>owner_id then raise exception 'New duplicate opened a separate stock ledger'; end if;
 end;
 if (select sum(delta) from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR')<>6 then raise exception 'New product receipt mismatch'; end if;
end $$;
rollback;
select 'PASS: shipment, edit, retry, unselected lines, receipt, recount, backdated guard, new duplicate; all synthetic rows rolled back' result;
