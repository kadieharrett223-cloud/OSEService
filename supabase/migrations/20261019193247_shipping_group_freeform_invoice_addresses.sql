set local lock_timeout = '5s';
-- Normalize only a single complete city, ST ZIP line in the invoice ShipAddr.
-- The original invoice address remains stored verbatim for provenance.
create function public.normalized_invoice_delivery_address(address jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = public, pg_temp as $function$
declare matched text[]; found text[]; matches integer := 0; line_number integer;
begin
  if jsonb_typeof(address) is distinct from 'object' then return null; end if;
  if coalesce(nullif(trim(address->>'City'),''), nullif(trim(address->>'CountrySubDivisionCode'),''), nullif(trim(address->>'PostalCode'),'')) is not null then return address; end if;
  for line_number in 1..5 loop
    matched := regexp_match(trim(address->>('Line'||line_number)), $pattern$^([A-Za-z][A-Za-z. '-]*),[[:space:]]*([A-Z]{2})[[:space:]]+([0-9]{5}(-[0-9]{4})?)$$pattern$);
    if matched is not null then matches := matches+1; found := matched; end if;
  end loop;
  if matches=1 then return address || jsonb_build_object('City',found[1],'CountrySubDivisionCode',found[2],'PostalCode',found[3]); end if;
  return address;
end;
$function$;
revoke all on function public.normalized_invoice_delivery_address(jsonb) from public, anon, authenticated;

create or replace function public.sync_order_invoice_delivery_address()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare address jsonb; normalized jsonb;
begin
  if tg_table_name = 'shipping_orders' then
    select raw_payload->'ShipAddr' into address from public.qbo_invoices where id=new.source_invoice_id;
  else address := new.raw_payload->'ShipAddr'; end if;
  if jsonb_typeof(address) is distinct from 'object' then address := null; end if;
  normalized := public.normalized_invoice_delivery_address(address);
  if tg_table_name = 'shipping_orders' then
    new.delivery_address := address;
    new.delivery_city := nullif(trim(normalized->>'City'),'');
    new.delivery_state := nullif(upper(trim(normalized->>'CountrySubDivisionCode')),'');
    new.delivery_postal_code := nullif(trim(normalized->>'PostalCode'),'');
    new.delivery_country := nullif(upper(trim(normalized->>'Country')),'');
  else
    update public.shipping_orders set
      delivery_address=address, delivery_city=nullif(trim(normalized->>'City'),''),
      delivery_state=nullif(upper(trim(normalized->>'CountrySubDivisionCode')),''),
      delivery_postal_code=nullif(trim(normalized->>'PostalCode'),''),
      delivery_country=nullif(upper(trim(normalized->>'Country')),'')
    where source_invoice_id=new.id and
      row(delivery_address,delivery_city,delivery_state,delivery_postal_code,delivery_country) is distinct from
      row(address,nullif(trim(normalized->>'City'),''),nullif(upper(trim(normalized->>'CountrySubDivisionCode')),''),nullif(trim(normalized->>'PostalCode'),''),nullif(upper(trim(normalized->>'Country')),''));
  end if;
  return new;
end;
$$;

with normalized as (
  select id, public.normalized_invoice_delivery_address(raw_payload->'ShipAddr') as address from public.qbo_invoices
)
update public.shipping_orders o set
  delivery_city=nullif(trim(n.address->>'City'),''),
  delivery_state=nullif(upper(trim(n.address->>'CountrySubDivisionCode')),''),
  delivery_postal_code=nullif(trim(n.address->>'PostalCode'),'')
from normalized n where o.source_invoice_id=n.id and
  row(o.delivery_city,o.delivery_state,o.delivery_postal_code) is distinct from
  row(nullif(trim(n.address->>'City'),''),nullif(upper(trim(n.address->>'CountrySubDivisionCode')),''),nullif(trim(n.address->>'PostalCode'),''));
