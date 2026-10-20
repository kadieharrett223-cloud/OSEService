-- Shipment writes enter through authenticated server actions using service_role.
-- Do not expose the SECURITY DEFINER stock-mutating RPCs as public endpoints.
revoke execute on function public.complete_order_shipment(uuid,timestamptz,text,text,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.edit_order_shipment(uuid,uuid,timestamptz,text,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.complete_order_shipment(uuid,timestamptz,text,text,text,text,jsonb) to service_role;
grant execute on function public.edit_order_shipment(uuid,uuid,timestamptz,text,text,text,jsonb,uuid) to service_role;
create policy inventory_stock_routes_service_only on public.inventory_stock_routes
 for all to service_role using(true) with check(true);
