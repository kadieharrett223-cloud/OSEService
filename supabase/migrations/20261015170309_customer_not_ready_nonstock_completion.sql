-- Only classify the new source into the existing non-stock completion branch.
-- Preserve locks, idempotency, the saved source, and all existing stock math,
-- including compensating shipment edits. No operational data is written here.
do $migration$
declare
  target record;
  definition text;
  anchor text;
begin
  for target in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('complete_order_shipment', 'edit_order_shipment') loop
    definition := pg_get_functiondef(target.oid);
    anchor := case when target.proname='edit_order_shipment'
      then 'coalesce(nullif(trim(upper(l.fulfillment_source)), ''''), ''WAREHOUSE'')'
      else 'coalesce(nullif(trim(upper(fulfillment_source)), ''''), ''WAREHOUSE'')' end;
    if position('CUSTOMER_NOT_READY' in definition) = 0 then
      if position(anchor in definition) = 0 then raise exception 'Shipment RPC changed; review % before patching', target.proname; end if;
      definition := replace(definition, anchor, 'case when ' || anchor || ' = ''CUSTOMER_NOT_READY'' then ''OTHER'' else ' || anchor || ' end');
      execute definition;
    end if;
  end loop;
end;
$migration$;
