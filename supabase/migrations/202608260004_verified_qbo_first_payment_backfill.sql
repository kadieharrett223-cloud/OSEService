create or replace function public.apply_verified_qbo_first_payment_backfill(
  p_proposals jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal record;
  v_updated integer := 0;
begin
  if jsonb_typeof(p_proposals) <> 'array' or jsonb_array_length(p_proposals) = 0 then
    raise exception 'At least one verified first-payment proposal is required';
  end if;

  for v_proposal in
    select * from jsonb_to_recordset(p_proposals) as proposal(order_id uuid, first_payment_at timestamptz)
  loop
    if v_proposal.order_id is null or v_proposal.first_payment_at is null then
      raise exception 'Each proposal requires an order ID and first payment timestamp';
    end if;

    update public.shipping_orders
      set first_payment_at = v_proposal.first_payment_at
      where id = v_proposal.order_id
        and first_payment_at is null;
    if not found then
      raise exception 'Order % is absent or no longer has a NULL first_payment_at', v_proposal.order_id;
    end if;
    v_updated := v_updated + 1;
  end loop;

  if v_updated <> jsonb_array_length(p_proposals) then
    raise exception 'Verified first-payment proposal count mismatch';
  end if;
  return v_updated;
end;
$$;

revoke all on function public.apply_verified_qbo_first_payment_backfill(jsonb) from public;
grant execute on function public.apply_verified_qbo_first_payment_backfill(jsonb) to service_role;