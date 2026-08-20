create or replace function public.cancel_voided_order(
  p_order_id uuid,
  p_reason text default 'Voided in QuickBooks'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.shipping_orders%rowtype;
  v_line record;
  v_open_demand numeric := 0;
  v_queue_units numeric := 0;
  v_reservation_qty numeric := 0;
  v_container_qty numeric := 0;
  v_shipped_qty numeric := 0;
  v_product_ids uuid[] := '{}';
  v_line_ids uuid[] := '{}';
  v_audit_details jsonb;
begin
  select * into v_order from public.shipping_orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if coalesce(v_order.cancellation_status, '') = 'CANCELLED' then
    return jsonb_build_object('status', 'already_cancelled', 'order_id', p_order_id);
  end if;

  for v_line in
    select l.* from public.shipping_order_lines l
    where l.shipping_order_id = p_order_id
    for update
  loop
    v_shipped_qty := v_shipped_qty + coalesce(v_line.fulfilled_qty, 0);
    if coalesce(v_line.fulfilled_qty, 0) >= greatest(coalesce(v_line.approved_qty, 0), coalesce(v_line.ordered_qty, 0)) then
      continue;
    end if;

    v_open_demand := v_open_demand + greatest(0, greatest(coalesce(v_line.approved_qty, 0), coalesce(v_line.ordered_qty, 0)) - coalesce(v_line.fulfilled_qty, 0));
    v_queue_units := v_queue_units + greatest(0, coalesce(v_line.approved_qty, 0) - coalesce(v_line.fulfilled_qty, 0));
    v_line_ids := array_append(v_line_ids, v_line.id);
    if v_line.product_id is not null then v_product_ids := array_append(v_product_ids, v_line.product_id); end if;

    select v_reservation_qty + coalesce(sum(quantity), 0) into v_reservation_qty
      from public.inventory_allocations
      where shipping_order_line_id = v_line.id
        and coalesce(allocation_status, 'ALLOCATED') <> 'RELEASED';

    select coalesce(sum(quantity), 0) into v_container_qty
      from public.inventory_allocations
      where shipping_order_line_id = v_line.id
        and source_type = 'CONTAINER'
        and coalesce(allocation_status, 'ALLOCATED') <> 'RELEASED';
  end loop;

  if cardinality(v_line_ids) > 0 then
    update public.inventory_allocations
      set allocation_status = 'RELEASED'
      where shipping_order_line_id = any(v_line_ids)
        and coalesce(allocation_status, 'ALLOCATED') <> 'RELEASED';

    update public.shipping_order_lines
      set approval_status = 'REMOVED',
          fulfillment_status = 'CANCELLED',
          warehouse_status = 'ON_FLOOR',
          queue_position_start = null,
          queue_position_count = null
      where id = any(v_line_ids);
  end if;

  update public.shipping_orders
    set cancellation_status = 'CANCELLED',
        cancellation_reason = coalesce(nullif(trim(p_reason), ''), 'Voided in QuickBooks'),
        cancelled_at = now()
    where id = p_order_id;

  v_audit_details := jsonb_build_object(
    'order_id', p_order_id,
    'action', 'CANCEL_ORDER_VOIDED',
    'reason', coalesce(nullif(trim(p_reason), ''), 'Voided in QuickBooks'),
    'open_demand_removed', v_open_demand,
    'queue_units_released', v_queue_units,
    'reservation_units_released', v_reservation_qty,
    'container_units_released', v_container_qty,
    'shipped_quantity_preserved', v_shipped_qty,
    'physical_inventory_changed', false,
    'shipment_history_changed', false,
    'container_quantities_changed', false
  );

  insert into public.audit_log(entity_type, entity_id, action, details)
    values ('shipping_order', p_order_id, 'ORDER_CANCELLED_VOIDED_QBO', v_audit_details);

  return v_audit_details || jsonb_build_object('status', 'cancelled');
end;
$$;
