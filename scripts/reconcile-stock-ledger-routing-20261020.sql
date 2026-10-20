-- Authorized ledger-identity repair, NOT another shipment or a recount.
-- Re-links six existing post-count deductions (7 units total).
-- Original IDs/deltas/event keys/shipment quantities/timestamps are retained.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
lock table public.inventory_transactions in share row exclusive mode;
do $$
declare
 v record; t public.inventory_transactions%rowtype; owner_id uuid; last_count timestamptz; shipped_at timestamptz;
 before_rows jsonb; after_rows jsonb; before_state text; after_state text; ledger_invariant text; after_invariant text;
 before_floor numeric; after_floor numeric; v_before_qty numeric;
begin
 if exists(select 1 from public.audit_log where action='STOCK_LEDGER_RECONCILED' and details->>'repair_key'='stock-routing-20261020-v1') then return; end if;
 -- Abort if a coworker's stock change has happened since the reviewed snapshot.
 for v in select * from (values
 ('000001','f39db1a7a918520f15593abead23a0f9'),('2PBP-8','2aa4e25dc1bd22ee6606b7201382628a'),
 ('000003','cbe0ba0f04b781a20d17cdbed036a5d5'),('2PCFXL-10','1b3e53ad94d851005ebae1a4d77a5583'),
 ('000040','c95412fdcef301a5a669a519efbe8b84'),('MRSL-6','07bec43f8113199b780d1ea7b91f7188'),
 ('000179','8b7a8712c525c00d19b033ebc840c4c9'),('TJ1101A','70ce768663777e58b8557b0e22ed580f')
 ) x(sku,expected_hash) loop
   if (select md5(jsonb_agg(to_jsonb(i) order by i.id)::text) from public.inventory_transactions i join public.products p on p.id=i.product_id where p.sku=v.sku and i.bucket='ON_FLOOR') is distinct from v.expected_hash then
     raise exception 'Stock changed since preview for %, aborting',v.sku;
   end if;
 end loop;
 select md5(jsonb_build_array(
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.order_shipments s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.order_shipment_lines s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.fulfillments s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.shipping_order_lines s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.inventory_allocations s)
 )::text) into before_state;
 -- Product identity and running-balance metadata may change, never quantities,
 -- source event identity, actor, date, order-line or shipment references.
 select md5(jsonb_agg(jsonb_build_array(i.id,i.delta,i.source_type,i.source_event_key,i.shipping_order_line_id,i.container_id,i.actor_id,i.created_at) order by i.id)::text)
 into ledger_invariant from public.inventory_transactions i;

 for v in select * from (values
 ('288a9ab6-2d1b-4086-a649-1e3d32da740c'::uuid,-2),
 ('d2fa0793-9336-44e7-8058-dc9ad11fe909'::uuid,-1),
 ('14f03633-271f-4795-9519-d8ec93fc88c2'::uuid,-1),
 ('bb1aa799-c0fa-49b5-bfa8-68fea28fb778'::uuid,-1),
 ('2cb83147-796f-4c5a-9c7a-5154e3c0a6c2'::uuid,-1),
 ('fd003bbe-4f54-4fd5-b847-fd95dd7bdddc'::uuid,-1)
 ) x(id,expected_delta) loop
   select * into strict t from public.inventory_transactions where id=v.id for update;
   select stock_product_id into strict owner_id from public.inventory_stock_routes where product_id=t.product_id;
   if owner_id=t.product_id or t.bucket<>'ON_FLOOR' or t.source_type<>'FULFILLMENT' or t.delta<>v.expected_delta or t.stock_requested_product_id is not null then
     raise exception 'Unexpected deduction state for %',v.id;
   end if;
   select max(i.created_at) into last_count from public.inventory_transactions i
     where i.product_id=owner_id and i.bucket='ON_FLOOR' and i.source_type in ('ADJUSTMENT','RECOUNT');
   select s.shipped_at into strict shipped_at from public.order_shipments s where s.id::text=split_part(t.source_event_key,':',2);
   if last_count is null or shipped_at<=last_count then raise exception 'Delivery may already be counted for %',v.id; end if;
   select coalesce(sum(delta),0) into before_floor from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR';
   before_rows:=jsonb_build_array(to_jsonb(t));
   update public.inventory_transactions set stock_requested_product_id=product_id,product_id=owner_id,
     reason=reason||' [existing deduction re-linked to physical stock ledger; no additional shipment]'
     where id=t.id;
   select coalesce(sum(i.delta),0) into v_before_qty from public.inventory_transactions i
     where i.product_id=owner_id and i.bucket='ON_FLOOR' and (i.created_at,i.id)<(t.created_at,t.id);
   update public.inventory_transactions set before_qty=v_before_qty,after_qty=v_before_qty+delta where id=t.id;
   select jsonb_build_array(to_jsonb(i)) into after_rows from public.inventory_transactions i where id=t.id;
   select coalesce(sum(delta),0) into after_floor from public.inventory_transactions where product_id=owner_id and bucket='ON_FLOOR';
   insert into public.audit_log(entity_type,entity_id,action,details) values('product',owner_id,'STOCK_LEDGER_RECONCILED',jsonb_build_object(
     'repair_key','stock-routing-20261020-v1','authorized_by','Kadie','before',before_rows,'after',after_rows,
     'physical_shipped_at',shipped_at,'last_count_at',last_count,'displayed_before',before_floor,'displayed_after',after_floor,
     'additional_shipment',false,'delta_unchanged',true));
   insert into public.audit_log(entity_type,entity_id,action,details) values('product',owner_id,'STOCK_EDIT_ATTEMPT',jsonb_build_object(
     'actor_name','System — authorized ledger repair','displayed_qty',before_floor,'current_qty',before_floor,'requested_qty',after_floor,
     'reason','Existing shipment deduction re-linked from duplicate catalog record. No new shipment, stock recount, or extra deduction.',
     'outcome','LEDGER_RELINKED','transaction_id',t.id,'repair_key','stock-routing-20261020-v1'));
 end loop;

 select md5(jsonb_agg(jsonb_build_array(i.id,i.delta,i.source_type,i.source_event_key,i.shipping_order_line_id,i.container_id,i.actor_id,i.created_at) order by i.id)::text)
 into after_invariant from public.inventory_transactions i;
 select md5(jsonb_build_array(
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.order_shipments s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.order_shipment_lines s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.fulfillments s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.shipping_order_lines s),
   (select jsonb_agg(to_jsonb(s) order by s.id) from public.inventory_allocations s)
 )::text) into after_state;
 if after_state<>before_state or after_invariant<>ledger_invariant then raise exception 'Quantity/history preservation check failed'; end if;
end $$;
commit;
select p.sku,sum(t.delta) on_floor from public.products p join public.inventory_transactions t on t.product_id=p.id and t.bucket='ON_FLOOR'
 where p.sku in ('000001','000003','000040','000179') group by p.sku order by p.sku;
