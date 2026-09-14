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
     ) then
    raise exception 'Cancelled orders cannot be reopened or returned to an active review state';
  end if;

  if upper(coalesce(new.cancellation_status, '')) = 'CANCELLED'
     and upper(coalesce(new.review_status, '')) <> 'CANCELLED' then
    raise exception 'Cancelled orders must use the cancelled review state';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_cancelled_shipping_order_parent on public.shipping_orders;
create trigger guard_cancelled_shipping_order_parent
before update on public.shipping_orders
for each row execute function public.guard_cancelled_shipping_order_parent();

revoke all on function public.guard_cancelled_shipping_order_parent() from public, anon, authenticated;
