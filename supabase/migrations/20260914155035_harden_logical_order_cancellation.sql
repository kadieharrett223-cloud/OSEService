-- Cancellation is a logical-invoice operation. Historical imports can leave more
-- than one shipping_orders parent for the same QBO invoice, so closing only the
-- selected UUID can leave a sibling active in queues and order tabs.
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
  v_order_ids uuid[] := '{}'::uuid[];
  v_line_ids uuid[] := '{}'::uuid[];
  v_product_ids uuid[] := '{}'::uuid[];
  v_open_demand numeric := 0;
  v_queue_units numeric := 0;
  v_reservation_qty numeric := 0;
  v_container_qty numeric := 0;
  v_line_reservation_qty numeric := 0;
  v_line_container_qty numeric := 0;
  v_shipped_qty numeric := 0;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Voided in QuickBooks');
  v_audit_details jsonb;
begin
  select * into v_order
  from public.shipping_orders
  where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;

  select array_agg(o.id order by o.id)
  into v_order_ids
  from public.shipping_orders o
  where o.id = p_order_id
     or (v_order.source_invoice_id is not null and o.source_invoice_id = v_order.source_invoice_id);

  -- Serialize cancellation, refresh, allocation, and fulfillment attempts for
  -- every physical parent that represents this logical invoice.
  perform 1
  from public.shipping_orders o
  where o.id = any(v_order_ids)
  order by o.id
  for update;

  if not exists (
    select 1 from public.shipping_orders o
    where o.id = any(v_order_ids)
      and upper(coalesce(o.cancellation_status, '')) <> 'CANCELLED'
  ) then
    return jsonb_build_object('status', 'already_cancelled', 'order_id', p_order_id, 'order_ids', to_jsonb(v_order_ids));
  end if;

  for v_line in
    select l.*
    from public.shipping_order_lines l
    where l.shipping_order_id = any(v_order_ids)
    order by l.id
    for update
  loop
    v_shipped_qty := v_shipped_qty + coalesce(v_line.fulfilled_qty, 0);
    if coalesce(v_line.fulfilled_qty, 0) >= greatest(coalesce(v_line.approved_qty, 0), coalesce(v_line.ordered_qty, 0)) then
      continue;
    end if;

    v_open_demand := v_open_demand + greatest(0, greatest(coalesce(v_line.approved_qty, 0), coalesce(v_line.ordered_qty, 0)) - coalesce(v_line.fulfilled_qty, 0));
    v_queue_units := v_queue_units + greatest(0, coalesce(v_line.approved_qty, 0) - coalesce(v_line.fulfilled_qty, 0));
    v_line_ids := array_append(v_line_ids, v_line.id);
    if v_line.product_id is not null then
      v_product_ids := array_append(v_product_ids, v_line.product_id);
    end if;

    select coalesce(sum(quantity), 0),
           coalesce(sum(quantity) filter (where source_type = 'CONTAINER'), 0)
      into v_line_reservation_qty, v_line_container_qty
    from public.inventory_allocations
    where shipping_order_line_id = v_line.id
      and upper(coalesce(allocation_status, 'ALLOCATED')) <> 'RELEASED';

    v_reservation_qty := v_reservation_qty + v_line_reservation_qty;
    v_container_qty := v_container_qty + v_line_container_qty;
  end loop;

  if cardinality(v_line_ids) > 0 then
    update public.inventory_allocations
    set allocation_status = 'RELEASED'
    where shipping_order_line_id = any(v_line_ids)
      and upper(coalesce(allocation_status, 'ALLOCATED')) <> 'RELEASED';

    update public.shipping_order_lines
    set approval_status = 'REMOVED',
        allocation_status = 'RELEASED',
        fulfillment_status = 'CANCELLED',
        warehouse_status = 'ON_FLOOR',
        queue_position_start = null,
        queue_position_count = null
    where id = any(v_line_ids);
  end if;

  update public.shipping_orders
  set cancellation_status = 'CANCELLED',
      cancellation_reason = v_reason,
      cancelled_at = now(),
      review_status = 'CANCELLED'
  where id = any(v_order_ids);

  v_audit_details := jsonb_build_object(
    'order_id', p_order_id,
    'order_ids', to_jsonb(v_order_ids),
    'action', 'CANCEL_LOGICAL_ORDER',
    'reason', v_reason,
    'open_demand_removed', v_open_demand,
    'queue_units_released', v_queue_units,
    'reservation_units_released', v_reservation_qty,
    'container_units_released', v_container_qty,
    'shipped_quantity_preserved', v_shipped_qty,
    'physical_inventory_changed', false,
    'shipment_history_changed', false,
    'container_quantities_changed', false,
    'product_ids', to_jsonb(v_product_ids)
  );

  insert into public.audit_log(entity_type, entity_id, action, details)
  values ('shipping_order', p_order_id, 'ORDER_CANCELLED_LOGICAL_INVOICE', v_audit_details);

  return v_audit_details || jsonb_build_object('status', 'cancelled');
end;
$$;

-- A stale browser, a direct form post, or a future server action must never be
-- able to reopen demand after the parent has been cancelled.
create or replace function public.guard_cancelled_shipping_order_line()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_parent_cancelled boolean;
  v_remaining numeric;
begin
  select upper(coalesce(o.cancellation_status, '')) = 'CANCELLED'
  into v_parent_cancelled
  from public.shipping_orders o
  where o.id = new.shipping_order_id;

  if not coalesce(v_parent_cancelled, false) then return new; end if;
  if tg_op = 'INSERT' then raise exception 'Cancelled orders cannot receive new operational lines'; end if;

  v_remaining := greatest(0, greatest(coalesce(new.ordered_qty, 0), coalesce(new.approved_qty, 0)) - coalesce(new.fulfilled_qty, 0));
  if new.queue_position_start is not null
     or new.queue_position_count is not null
     or upper(coalesce(new.fulfillment_status, '')) not in ('CANCELLED', 'FULFILLED')
     or (v_remaining > 0 and (
       upper(coalesce(new.fulfillment_status, '')) <> 'CANCELLED'
       or upper(coalesce(new.approval_status, '')) <> 'REMOVED'
       or upper(coalesce(new.allocation_status, '')) <> 'RELEASED'
     )) then
    raise exception 'Cancelled orders cannot be returned to an active fulfillment or customer queue state';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_cancelled_shipping_order_line on public.shipping_order_lines;
create trigger guard_cancelled_shipping_order_line
before insert or update on public.shipping_order_lines
for each row execute function public.guard_cancelled_shipping_order_line();

create or replace function public.guard_cancelled_order_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_parent_cancelled boolean;
begin
  select upper(coalesce(o.cancellation_status, '')) = 'CANCELLED'
  into v_parent_cancelled
  from public.shipping_order_lines l
  join public.shipping_orders o on o.id = l.shipping_order_id
  where l.id = new.shipping_order_line_id;

  if coalesce(v_parent_cancelled, false)
     and upper(coalesce(new.allocation_status, 'ALLOCATED')) <> 'RELEASED' then
    raise exception 'Inventory cannot be allocated to a cancelled order';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_cancelled_order_allocation on public.inventory_allocations;
create trigger guard_cancelled_order_allocation
before insert or update on public.inventory_allocations
for each row execute function public.guard_cancelled_order_allocation();

-- Only trusted server code may execute the SECURITY DEFINER cancellation RPC.
revoke all on function public.cancel_voided_order(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_voided_order(uuid, text) to service_role;
revoke all on function public.guard_cancelled_shipping_order_line() from public, anon, authenticated;
revoke all on function public.guard_cancelled_order_allocation() from public, anon, authenticated;

-- Repair historical duplicate-parent cancellations with the same transaction,
-- then normalize the parent and line-level closed-state markers.
do $$
declare
  v_order_id uuid;
begin
  for v_order_id in
    select (array_agg(o.id order by o.id) filter (
      where upper(coalesce(o.cancellation_status, '')) = 'CANCELLED'
    ))[1]
    from public.shipping_orders o
    where o.source_invoice_id is not null
    group by o.source_invoice_id
    having count(*) filter (where upper(coalesce(o.cancellation_status, '')) = 'CANCELLED') > 0
       and count(*) filter (where upper(coalesce(o.cancellation_status, '')) <> 'CANCELLED') > 0
  loop
    perform public.cancel_voided_order(v_order_id, 'Reconciled logical invoice cancellation');
  end loop;
end;
$$;

update public.shipping_orders
set review_status = 'CANCELLED'
where upper(coalesce(cancellation_status, '')) = 'CANCELLED'
  and upper(coalesce(review_status, '')) <> 'CANCELLED';

update public.shipping_order_lines l
set allocation_status = 'RELEASED',
    queue_position_start = null,
    queue_position_count = null
from public.shipping_orders o
where o.id = l.shipping_order_id
  and upper(coalesce(o.cancellation_status, '')) = 'CANCELLED'
  and greatest(coalesce(l.ordered_qty, 0), coalesce(l.approved_qty, 0)) - coalesce(l.fulfilled_qty, 0) > 0
  and upper(coalesce(l.fulfillment_status, '')) = 'CANCELLED'
  and upper(coalesce(l.approval_status, '')) = 'REMOVED';
