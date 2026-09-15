-- A cancellation is immutable by default.  This narrowly-scoped RPC is the only
-- way to restore a cancelled order after an operator confirms that its live QBO
-- invoice remains open.  It preserves the cancellation audit trail while putting
-- the original mapped demand back into the canonical customer queue.
create or replace function public.guard_cancelled_shipping_order_parent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if upper(coalesce(old.cancellation_status, '')) = 'CANCELLED'
     and (
       upper(coalesce(new.cancellation_status, '')) <> 'CANCELLED'
       or upper(coalesce(new.review_status, '')) <> 'CANCELLED'
     )
     and coalesce(current_setting('app.allow_cancel_restore', true), '') <> 'on' then
    raise exception 'Cancelled orders cannot be reopened or returned to an active review state';
  end if;

  if upper(coalesce(new.cancellation_status, '')) = 'CANCELLED'
     and upper(coalesce(new.review_status, '')) <> 'CANCELLED' then
    raise exception 'Cancelled orders must use the cancelled review state';
  end if;

  return new;
end;
$$;

create or replace function public.restore_cancelled_order(
  p_order_id uuid,
  p_reason text default 'Restored after live QuickBooks verification'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.shipping_orders%rowtype;
  v_voided boolean := false;
  v_restored_lines integer := 0;
  v_product_ids uuid[] := '{}'::uuid[];
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Restored after live QuickBooks verification');
begin
  select * into v_order
  from public.shipping_orders
  where id = p_order_id
  for update;
  if not found then raise exception 'Order not found'; end if;
  if upper(coalesce(v_order.cancellation_status, '')) <> 'CANCELLED' then
    raise exception 'Only a cancelled order can be restored';
  end if;

  if v_order.source_invoice_id is not null then
    select upper(coalesce(raw_payload->>'PrivateNote', '')) = 'VOIDED'
      into v_voided
    from public.qbo_invoices
    where id = v_order.source_invoice_id;
    if v_voided then
      raise exception 'A voided QuickBooks invoice cannot be restored';
    end if;
  end if;

  -- The parent trigger permits this transaction only; direct updates remain blocked.
  perform set_config('app.allow_cancel_restore', 'on', true);
  update public.shipping_orders
  set cancellation_status = null,
      cancellation_reason = concat('Restored: ', v_reason),
      cancelled_at = null,
      review_status = 'APPROVED'
  where id = p_order_id;

  update public.shipping_order_lines
  set approved_qty = greatest(coalesce(approved_qty, 0), coalesce(ordered_qty, 0)),
      approval_status = case when product_id is null then 'PENDING_REVIEW' else 'APPROVED' end,
      allocation_status = 'UNALLOCATED',
      fulfillment_status = 'PENDING',
      warehouse_status = 'ON_FLOOR',
      queue_position_start = null,
      queue_position_count = null
  where shipping_order_id = p_order_id
    and coalesce(fulfilled_qty, 0) < greatest(coalesce(approved_qty, 0), coalesce(ordered_qty, 0));
  get diagnostics v_restored_lines = row_count;

  select coalesce(array_agg(distinct product_id) filter (where product_id is not null), '{}'::uuid[])
    into v_product_ids
  from public.shipping_order_lines
  where shipping_order_id = p_order_id;

  insert into public.audit_log(entity_type, entity_id, action, details)
  values ('shipping_order', p_order_id, 'ORDER_RESTORED_AFTER_CANCELLATION', jsonb_build_object(
    'reason', v_reason,
    'restored_line_count', v_restored_lines,
    'product_ids', to_jsonb(v_product_ids),
    'physical_inventory_changed', false,
    'shipment_history_changed', false,
    'allocations_remain_released', true
  ));

  return jsonb_build_object('status', 'restored', 'order_id', p_order_id, 'restored_line_count', v_restored_lines, 'product_ids', to_jsonb(v_product_ids));
end;
$$;

revoke all on function public.restore_cancelled_order(uuid, text) from public, anon, authenticated;
