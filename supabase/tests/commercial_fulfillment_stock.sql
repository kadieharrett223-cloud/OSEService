begin;
set local role service_role;
do $test$
declare c uuid; p uuid; o uuid; cl uuid; pl uuid; ul uuid; sh uuid; k text:=replace(gen_random_uuid()::text,'-','');
begin
 insert into public.products(sku,canonical_name) values('SYNTH-C-'||k,'Installation Service') returning id into c;
 insert into public.products(sku,canonical_name) values('SYNTH-P-'||k,'Lift with free shipping') returning id into p;
 insert into public.inventory_transactions(product_id,bucket,delta,reason,source_type,source_event_key)
 values(c,'ON_FLOOR',-1,'synthetic rollback guard test','FULFILLMENT','synthetic-c-'||k);
 if exists(select 1 from public.inventory_transactions where product_id=c) then raise exception 'Commercial completion changed stock'; end if;
 if (select count(*) from public.audit_log where entity_id=c and action='NON_INVENTORY_STOCK_WRITE_SKIPPED')<>1 then raise exception 'Skipped movement missing audit'; end if;
 insert into public.inventory_transactions(product_id,bucket,delta,reason,source_type,source_event_key)
 values(p,'ON_FLOOR',5,'synthetic rollback seed','ADJUSTMENT','synthetic-seed-'||k),
       (p,'ON_FLOOR',-1,'synthetic rollback shipment','FULFILLMENT','synthetic-physical-'||k),
       (c,'ON_FLOOR',2,'synthetic rollback adjustment','ADJUSTMENT','synthetic-adjust-'||k);
 if (select sum(delta) from public.inventory_transactions where product_id=p)<>4 then raise exception 'Physical shipment did not deduct exactly once'; end if;
 if (select sum(delta) from public.inventory_transactions where product_id=c)<>2 then raise exception 'Non-fulfillment adjustment incorrectly suppressed'; end if;
 insert into public.shipping_orders default values returning id into o;
 insert into public.shipping_order_lines(shipping_order_id,product_id,ordered_qty,approved_qty,approval_status,fulfillment_source)
 values(o,c,1,1,'APPROVED','WAREHOUSE') returning id into cl;
 insert into public.shipping_order_lines(shipping_order_id,product_id,ordered_qty,approved_qty,approval_status,fulfillment_source)
 values(o,p,1,1,'APPROVED','WAREHOUSE') returning id into pl;
 insert into public.shipping_order_lines(shipping_order_id,product_id,ordered_qty,approved_qty,approval_status,fulfillment_source)
 values(o,p,1,1,'APPROVED','WAREHOUSE') returning id into ul;
 sh:=public.complete_order_shipment(o,now(),'Synthetic rollback test',null,null,'synthetic-shipment-'||k,
   jsonb_build_array(jsonb_build_object('line_id',cl,'quantity',1),jsonb_build_object('line_id',pl,'quantity',1)));
 if (select fulfilled_qty from public.shipping_order_lines where id=cl)<>1 then raise exception 'Service completion failed'; end if;
 if (select fulfilled_qty from public.shipping_order_lines where id=ul)<>0 then raise exception 'Unselected line was fulfilled'; end if;
 if (select sum(delta) from public.inventory_transactions where product_id=c)<>2 then raise exception 'Shipment RPC deducted service stock'; end if;
 if (select sum(delta) from public.inventory_transactions where product_id=p)<>3 then raise exception 'Shipment RPC physical deduction incorrect'; end if;
 if public.complete_order_shipment(o,now(),'Synthetic rollback test',null,null,'synthetic-shipment-'||k,
   jsonb_build_array(jsonb_build_object('line_id',cl,'quantity',1),jsonb_build_object('line_id',pl,'quantity',1)))<>sh then raise exception 'Shipment retry duplicated shipment'; end if;
 if (select sum(delta) from public.inventory_transactions where product_id=p)<>3 then raise exception 'Shipment retry duplicated deduction'; end if;
end;
$test$;
rollback;
select jsonb_build_object('rollback_tests','passed','synthetic_products_remaining',(select count(*) from public.products where sku like 'SYNTH-%'),'ledger_rows',(select count(*) from public.inventory_transactions),'stock_hash',(select md5(string_agg(row_to_json(t)::text,',' order by id)) from public.inventory_transactions t)) as evidence;
