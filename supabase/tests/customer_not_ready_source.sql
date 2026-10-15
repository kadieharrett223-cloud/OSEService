-- Exercise the actual deployed CHECK expression without modifying customer data.
do $$
declare
  source_check text;
  failures integer;
begin
  select pg_get_expr(conbin, conrelid) into strict source_check
  from pg_constraint
  where conrelid = 'public.shipping_order_lines'::regclass
    and conname = 'shipping_order_lines_fulfillment_source_check';

  execute format(
    'select count(*) from (values
      (null::text, true), (''WAREHOUSE'', true), (''DROPSHIP'', true),
      (''OTHER'', true), (''CUSTOMER_NOT_READY'', true),
      (''INVALID_SOURCE'', false), ('''', false)
    ) as cases(fulfillment_source, expected)
    where coalesce((%s), true) is distinct from expected', source_check
  ) into failures;
  if failures <> 0 then
    raise exception 'Fulfillment source CHECK failed % regression cases', failures;
  end if;
end;
$$;
