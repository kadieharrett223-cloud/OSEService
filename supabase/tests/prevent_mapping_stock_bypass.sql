begin;
create temporary table source_guard_fixture (
  id integer primary key, fulfillment_source text, fulfillment_notes text,
  fulfilled_qty numeric default 0, queue_position_start integer
) on commit drop;
-- Existing historical exception copied before attaching the actual deployed trigger.
insert into source_guard_fixture values (1,'OTHER','OCC Mapping Error',1,1), (2,'WAREHOUSE',null,0,2);
create trigger test_source_guard before insert or update of fulfillment_source,fulfillment_notes,fulfilled_qty
on source_guard_fixture for each row execute function public.reject_mapping_stock_bypass();
do $$ begin
  begin
    insert into source_guard_fixture values (3,'OTHER','OCC Mapping Error',0,3);
    raise exception 'Mapping bypass insert was accepted';
  exception when check_violation then null; end;
  begin
    update source_guard_fixture set fulfillment_source='OTHER',fulfillment_notes='Mapping issue' where id=2;
    raise exception 'Mapping bypass update was accepted';
  exception when check_violation then null; end;
  begin
    update source_guard_fixture set fulfilled_qty=2 where id=1;
    raise exception 'Legacy mapping bypass completion was accepted';
  exception when check_violation then null; end;
  -- Historical display/position updates and legitimate documented sources still work.
  update source_guard_fixture set queue_position_start=4 where id=1;
  insert into source_guard_fixture values (4,'OTHER','Customer supplied equipment, reference123',0,4);
  update source_guard_fixture set fulfilled_qty=1 where id=4;
  update source_guard_fixture set fulfillment_source='WAREHOUSE' where id=1;
  if (select fulfilled_qty from source_guard_fixture where id=1)<>1 then raise exception 'Historical quantity changed';end if;
end $$;
rollback;
