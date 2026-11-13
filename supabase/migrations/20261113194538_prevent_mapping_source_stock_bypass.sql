-- Validate future source changes; do not rewrite historical sources or replay shipments.
create or replace function public.reject_mapping_stock_bypass()
returns trigger language plpgsql security invoker set search_path = public as $$
declare mapping_problem boolean;
begin
  mapping_problem := coalesce(new.fulfillment_notes,'') ~* '(mapping|mapped)[[:space:]]*(error|issue|problem|fix|correction)|(missing|incorrect|wrong|broken)[[:space:]]*(product[[:space:]]*)?mapping|\munmapped\M';
  if mapping_problem and upper(coalesce(new.fulfillment_source,'')) in ('OTHER','CUSTOMER_NOT_READY') then
    if tg_op = 'INSERT' then
      if upper(new.fulfillment_source) = 'OTHER' then
        raise exception 'Mapping problems cannot authorize non-stock fulfillment' using errcode='23514';
      end if;
    elsif (upper(new.fulfillment_source) = 'OTHER' and
          (new.fulfillment_source is distinct from old.fulfillment_source or new.fulfillment_notes is distinct from old.fulfillment_notes))
          or coalesce(new.fulfilled_qty,0) > coalesce(old.fulfilled_qty,0) then
      raise exception 'Mapping problems cannot authorize non-stock fulfillment' using errcode='23514';
    end if;
  end if;
  return new;
end; $$;

create trigger prevent_mapping_stock_bypass
before insert or update of fulfillment_source, fulfillment_notes, fulfilled_qty
on public.shipping_order_lines for each row execute function public.reject_mapping_stock_bypass();
