begin;
-- Copy the actual deployed constraint, not a second hand-written version of it.
create temporary table archived_order_status_fixture
  (like public.shipping_orders including defaults including constraints) on commit drop;
do $test$
declare v_status text;
begin
  foreach v_status in array array['PENDING_REVIEW','APPROVED','HOLD','FULFILLED','CANCELLED','ARCHIVED'] loop
    insert into archived_order_status_fixture(customer_id,source_type,review_status)
    values(gen_random_uuid(),'QBO_INVOICE',v_status);
  end loop;
  if (select count(*) from archived_order_status_fixture)<>6 then raise exception 'Accepted order states changed';end if;
  begin
    insert into archived_order_status_fixture(customer_id,source_type,review_status)
    values(gen_random_uuid(),'QBO_INVOICE','INVALID_STATE');
    raise exception 'Invalid status was accepted';
  exception when check_violation then null;
  end;
end;$test$;
rollback;
