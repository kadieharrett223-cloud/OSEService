-- Only the admin-authorized server action may call this. Installing it changes no stock.
create function public.recount_inventory_stock_group(
  p_group_ids uuid[], p_owner_ids uuid[], p_target_id uuid,
  p_expected numeric, p_target numeric, p_snapshot_count bigint,
  p_request_id uuid, p_actor_name text, p_actor_id text, p_reason text
) returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  v_current numeric; v_owner_current numeric; v_delta numeric; v_outcome text;
  v_prior jsonb; v_count bigint;
begin
  if p_target_id is null or not (p_target_id = any(p_group_ids)) or p_expected is null or p_target is null
    or p_target < 0 or p_target <> trunc(p_target) or p_request_id is null or coalesce(trim(p_reason),'') = ''
    or not (p_owner_ids <@ p_group_ids) then raise exception 'Invalid stock recount'; end if;
  -- Recounts are rare and this short lock also excludes existing shipment/receipt
  -- writers that do not participate in advisory locks. No external I/O is done here.
  lock table public.inventory_transactions in share row exclusive mode;
  select details into v_prior from public.audit_log where entity_type='product'
    and entity_id=p_target_id and action='STOCK_EDIT_ATTEMPT' and details->>'request_id'=p_request_id::text limit 1;
  if v_prior is not null then return v_prior; end if;
  select count(*) into v_count from public.inventory_transactions where product_id=any(p_group_ids) and bucket='ON_FLOOR';
  select coalesce(sum(delta),0) into v_current from public.inventory_transactions where product_id=any(p_owner_ids) and bucket='ON_FLOOR';
  v_outcome := case when v_count<>p_snapshot_count or v_current<>p_expected then 'STALE_COUNT'
    when v_current=p_target then 'ALREADY_MATCHES' else 'ADJUSTMENT_REQUESTED' end;
  v_delta := p_target-v_current;
  v_prior := jsonb_build_object('request_id',p_request_id,'actor_id',p_actor_id,'actor_name',p_actor_name,
    'displayed_qty',p_expected,'current_qty',v_current,'requested_qty',p_target,'reason',p_reason,'outcome',v_outcome,
    'stock_product_ids',p_owner_ids,'group_product_ids',p_group_ids,'delta',v_delta);
  insert into public.audit_log(entity_type,entity_id,action,details) values('product',p_target_id,'STOCK_EDIT_ATTEMPT',v_prior);
  if v_outcome<>'ADJUSTMENT_REQUESTED' then return v_prior; end if;
  select coalesce(sum(delta),0) into v_owner_current from public.inventory_transactions where product_id=p_target_id and bucket='ON_FLOOR';
  insert into public.inventory_transactions(product_id,bucket,delta,before_qty,after_qty,reason,source_type,source_event_key,actor_id)
    values(p_target_id,'ON_FLOOR',v_delta,v_owner_current,v_owner_current+v_delta,
      'Manual adjustment by '||p_actor_name||': '||p_reason,'ADJUSTMENT','manual-group:'||p_request_id::text,null);
  return v_prior;
end;
$$;
revoke all on function public.recount_inventory_stock_group(uuid[],uuid[],uuid,numeric,numeric,bigint,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.recount_inventory_stock_group(uuid[],uuid[],uuid,numeric,numeric,bigint,uuid,text,text,text) to service_role;
