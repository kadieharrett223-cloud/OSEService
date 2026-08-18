alter table public.shipping_orders
  add column if not exists fulfillment_method text not null default 'SHIP'
    check (fulfillment_method in ('SHIP', 'WILL_CALL'));

create table if not exists public.order_attachments (
  id uuid primary key default gen_random_uuid(),
  shipping_order_id uuid not null references public.shipping_orders(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_size bigint,
  mime_type text,
  uploaded_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_attachments_order
  on public.order_attachments(shipping_order_id, created_at desc);

alter table public.fulfillments
  add column if not exists fulfillment_type text not null default 'SHIPMENT'
    check (fulfillment_type in ('SHIPMENT', 'PICKUP'));

alter table public.order_attachments
  add column if not exists document_type text not null default 'OTHER'
    check (document_type in ('BOL', 'PACKING_LIST', 'PICKUP_RECEIPT', 'CUSTOMER_DOCUMENT', 'INSTALLATION', 'PHOTO', 'DRIVERS_LICENSE', 'OTHER'));

alter table public.order_attachments
  add column if not exists note text;

alter table public.order_attachments
  add column if not exists is_restricted boolean not null default false;

create table if not exists public.order_pickups (
  id uuid primary key default gen_random_uuid(),
  shipping_order_id uuid not null references public.shipping_orders(id) on delete cascade,
  pickup_person_name text not null,
  pickup_at timestamptz not null default now(),
  completed_by uuid references public.access_users(id) on delete set null,
  notes text,
  acknowledgment_document_id uuid references public.order_attachments(id) on delete restrict,
  drivers_license_document_id uuid references public.order_attachments(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_pickups_order on public.order_pickups(shipping_order_id, pickup_at desc);

alter table public.order_pickups enable row level security;
create policy "order_pickups_read_authenticated" on public.order_pickups for select to authenticated using (true);
create policy "order_pickups_write_authenticated" on public.order_pickups for all to authenticated using (true) with check (true);