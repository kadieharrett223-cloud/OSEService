create or replace function public.edit_order_shipment(
  p_shipment_id uuid,
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_carrier text,
  p_tracking_number text,
  p_notes text,
  p_lines jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment public.order_shipments%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_product_id uuid;
  v_approved numeric;
  v_current_fulfilled numeric;
  v_current_shipment_qty numeric;
  v_requested_qty numeric;
  v_delta numeric;
  v_current_floor numeric;
  v_current_sold numeric;
  v_event_key text;
begin
  select * into v_shipment
    from public.order_shipments
    where id = p_shipment_id and shipping_order_id = p_order_id
    for update;
  if not found then raise exception 'Shipment does not belong to this order'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Shipment lines must be an array'; end if;

  create temporary table shipment_edit_lines (
    shipping_order_line_id uuid primary key,
    requested_qty numeric not null
  ) on commit drop;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_id := nullif(v_line->>'line_id', '')::uuid;
    v_requested_qty := coalesce((v_line->>'quantity')::numeric, 0);
    if v_line_id is null or v_requested_qty <= 0 then
      raise exception 'Shipment lines must have a valid positive quantity';
    end if;
    insert into shipment_edit_lines(shipping_order_line_id, requested_qty)
      values (v_line_id, v_requested_qty)
      on conflict (shipping_order_line_id) do update set requested_qty = excluded.requested_qty;
  end loop;

  for v_line_id, v_requested_qty in
    select l.id, coalesce(e.requested_qty, 0)
    from public.shipping_order_lines l
    left join shipment_edit_lines e on e.shipping_order_line_id = l.id
    where l.shipping_order_id = p_order_id
    for update
  loop
    select l.product_id, l.approved_qty, l.fulfilled_qty
      into v_product_id, v_approved, v_current_fulfilled
      from public.shipping_order_lines l where l.id = v_line_id;
    select coalesce(sum(quantity), 0) into v_current_shipment_qty
      from public.order_shipment_lines where shipment_id = p_shipment_id and shipping_order_line_id = v_line_id;

    v_delta := v_requested_qty - v_current_shipment_qty;
    if v_delta = 0 then continue; end if;
    if coalesce(v_current_fulfilled, 0) - coalesce(v_current_shipment_qty, 0) + v_requested_qty > coalesce(v_approved, 0) then
      raise exception 'Shipment quantity exceeds the remaining amount for line %', v_line_id;
    end if;

    if v_requested_qty > 0 then
      insert into public.order_shipment_lines(shipment_id, shipping_order_line_id, quantity)
        values (p_shipment_id, v_line_id, v_requested_qty)
        on conflict (shipment_id, shipping_order_line_id) do update set quantity = excluded.quantity;
    else
      delete from public.order_shipment_lines
        where shipment_id = p_shipment_id and shipping_order_line_id = v_line_id;
    end if;

    update public.shipping_order_lines
      set fulfilled_qty = coalesce(v_current_fulfilled, 0) + v_delta,
          fulfillment_status = case when coalesce(v_current_fulfilled, 0) + v_delta >= coalesce(v_approved, 0) then 'FULFILLED' else case when coalesce(v_current_fulfilled, 0) + v_delta > 0 then 'PARTIALLY_FULFILLED' else 'PENDING' end end,
          warehouse_status = case when coalesce(v_current_fulfilled, 0) + v_delta >= coalesce(v_approved, 0) then 'FULFILLED' else case when coalesce(v_current_fulfilled, 0) + v_delta > 0 then 'PARTIALLY_FULFILLED' else 'APPROVED' end end
      where id = v_line_id;

    v_event_key := 'ORDER_SHIPMENT_EDIT:' || p_shipment_id::text || ':' || v_line_id::text || ':' || gen_random_uuid()::text;
    insert into public.fulfillments(shipping_order_line_id, fulfilled_qty, fulfilled_at, shipment_number, carrier, tracking_number, reason, source_event_key, fulfillment_type)
      values (v_line_id, v_delta, coalesce(p_shipped_at, v_shipment.shipped_at), v_shipment.shipment_number, nullif(trim(p_carrier), ''), nullif(trim(p_tracking_number), ''), 'Shipment contents edited', v_event_key, 'SHIPMENT');

    if v_product_id is not null then
      select coalesce(sum(delta), 0) into v_current_floor from public.inventory_transactions where product_id = v_product_id and bucket = 'ON_FLOOR';
      insert into public.inventory_transactions(product_id, bucket, delta, before_qty, after_qty, reason, source_type, source_event_key, shipping_order_line_id, actor_id)
        values (v_product_id, 'ON_FLOOR', -least(v_delta, greatest(0, v_current_floor)) , v_current_floor, greatest(0, v_current_floor - v_delta), 'Shipment contents edited', 'FULFILLMENT', v_event_key || ':ON_FLOOR', v_line_id, p_actor_id);
      select coalesce(sum(delta), 0) into v_current_sold from public.inventory_transactions where product_id = v_product_id and bucket = 'SOLD';
      insert into public.inventory_transactions(product_id, bucket, delta, before_qty, after_qty, reason, source_type, source_event_key, shipping_order_line_id, actor_id)
        values (v_product_id, 'SOLD', v_delta, v_current_sold, v_current_sold + v_delta, 'Shipment contents edited', 'FULFILLMENT', v_event_key || ':SOLD', v_line_id, p_actor_id);
    end if;
  end loop;

  update public.order_shipments
    set shipped_at = coalesce(p_shipped_at, shipped_at),
        carrier = nullif(trim(p_carrier), ''),
        tracking_number = nullif(trim(p_tracking_number), ''),
        notes = nullif(trim(p_notes), ''),
        created_by = coalesce(created_by, p_actor_id)
    where id = p_shipment_id;

  return p_shipment_id;
end;
$$;
