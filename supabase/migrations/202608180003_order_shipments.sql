create table if not exists public.order_shipments (
  id uuid primary key default gen_random_uuid(),
  shipping_order_id uuid not null references public.shipping_orders(id) on delete cascade,
  shipment_number text not null,
  shipped_at timestamptz not null,
  carrier text,
  tracking_number text,
  notes text,
  created_by uuid references public.access_users(id) on delete set null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint order_shipments_unique_number unique (shipping_order_id, shipment_number)
);

create table if not exists public.order_shipment_lines (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.order_shipments(id) on delete cascade,
  shipping_order_line_id uuid not null references public.shipping_order_lines(id) on delete restrict,
  quantity numeric(12,2) not null check (quantity > 0),
  created_at timestamptz not null default now(),
  constraint order_shipment_lines_unique_line unique (shipment_id, shipping_order_line_id)
);

alter table public.order_attachments
  add column if not exists shipment_id uuid references public.order_shipments(id) on delete set null;

create index if not exists idx_order_shipments_order on public.order_shipments(shipping_order_id, shipped_at desc);
create index if not exists idx_order_shipment_lines_shipment on public.order_shipment_lines(shipment_id);
create index if not exists idx_order_attachments_shipment on public.order_attachments(shipment_id);

alter table public.order_shipments enable row level security;
alter table public.order_shipment_lines enable row level security;
create policy "order_shipments_read_authenticated" on public.order_shipments for select to authenticated using (true);
create policy "order_shipments_write_authenticated" on public.order_shipments for all to authenticated using (true) with check (true);
create policy "order_shipment_lines_read_authenticated" on public.order_shipment_lines for select to authenticated using (true);
create policy "order_shipment_lines_write_authenticated" on public.order_shipment_lines for all to authenticated using (true) with check (true);

create or replace function public.complete_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_carrier text,
  p_tracking_number text,
  p_notes text,
  p_idempotency_key text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment_id uuid;
  v_shipment_number text;
  v_line jsonb;
  v_line_id uuid;
  v_quantity numeric;
  v_approved numeric;
  v_fulfilled numeric;
  v_next numeric;
begin
  select id into v_shipment_id from public.order_shipments where idempotency_key = p_idempotency_key;
  if v_shipment_id is not null then return v_shipment_id; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'At least one shipment line is required'; end if;

  v_shipment_number := 'SHIP-' || to_char(coalesce(p_shipped_at, now()), 'YYYYMMDD-HH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  insert into public.order_shipments(shipping_order_id, shipment_number, shipped_at, carrier, tracking_number, notes, idempotency_key)
  values (p_order_id, v_shipment_number, coalesce(p_shipped_at, now()), nullif(trim(p_carrier), ''), nullif(trim(p_tracking_number), ''), nullif(trim(p_notes), ''), p_idempotency_key)
  returning id into v_shipment_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_id := (v_line->>'line_id')::uuid;
    v_quantity := (v_line->>'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then raise exception 'Shipment quantity must be greater than zero'; end if;
    select approved_qty, fulfilled_qty into v_approved, v_fulfilled
      from public.shipping_order_lines where id = v_line_id and shipping_order_id = p_order_id for update;
    if not found then raise exception 'Shipment line does not belong to this order'; end if;
    v_next := coalesce(v_fulfilled, 0) + v_quantity;
    if v_next > coalesce(v_approved, 0) then raise exception 'Shipment quantity exceeds remaining quantity'; end if;
    insert into public.order_shipment_lines(shipment_id, shipping_order_line_id, quantity) values (v_shipment_id, v_line_id, v_quantity);
    update public.shipping_order_lines
      set fulfilled_qty = v_next,
          fulfillment_status = case when v_next >= coalesce(v_approved, 0) then 'FULFILLED' else 'PARTIALLY_FULFILLED' end,
          warehouse_status = case when v_next >= coalesce(v_approved, 0) then 'FULFILLED' else 'PARTIALLY_FULFILLED' end
      where id = v_line_id;
    insert into public.fulfillments(shipping_order_line_id, fulfilled_qty, fulfilled_at, shipment_number, carrier, tracking_number, reason, source_event_key, fulfillment_type)
      values (v_line_id, v_quantity, coalesce(p_shipped_at, now()), v_shipment_number, nullif(trim(p_carrier), ''), nullif(trim(p_tracking_number), ''), 'Order shipment completed', 'ORDER_SHIPMENT:' || v_shipment_id::text || ':' || v_line_id::text, 'SHIPMENT');
  end loop;
  return v_shipment_id;
end;
$$;
