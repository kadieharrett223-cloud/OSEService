-- Phase 1 inventory and shipping workflow tables
-- Additive expansion for products, QuickBooks imports, shipping review,
-- containers, inventory ledger, allocations, fulfillments, and audit history.

create extension if not exists pgcrypto;

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  canonical_name text not null,
  description text,
  status text not null default 'Active' check (status in ('Active', 'Inactive', 'Discontinued')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  alias text not null,
  source_type text not null default 'manual' check (source_type in ('manual', 'qbo', 'import')),
  source_ref text,
  created_at timestamptz not null default now(),
  constraint product_aliases_unique_alias unique (product_id, alias, source_type)
);

create table if not exists public.qbo_invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  qbo_invoice_id text not null unique,
  invoice_number text,
  invoice_date date,
  payment_status text not null default 'Pending' check (payment_status in ('Pending', 'Partially Paid', 'Paid', 'Unpaid', 'Voided')),
  total_amount numeric(12,2),
  raw_payload jsonb,
  sync_status text not null default 'Pending' check (sync_status in ('Pending', 'Imported', 'Failed', 'Skipped')),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.qbo_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  qbo_invoice_id uuid not null references public.qbo_invoices(id) on delete cascade,
  qbo_line_id text not null,
  qbo_item_id text,
  qbo_sku text,
  source_description text,
  product_id uuid references public.products(id) on delete set null,
  ordered_qty numeric(12,2) not null default 0,
  unit_price numeric(12,2),
  line_total numeric(12,2),
  mapping_status text not null default 'PENDING_REVIEW' check (mapping_status in ('PENDING_REVIEW', 'MAPPED', 'MAPPING_REVIEW', 'REMOVED')),
  approval_status text not null default 'PENDING_REVIEW' check (approval_status in ('PENDING_REVIEW', 'APPROVED', 'HOLD', 'PARTIAL', 'IN_WAREHOUSE', 'READY', 'FULFILLED', 'REMOVED', 'CANCELLED')),
  warehouse_status text not null default 'PENDING_REVIEW' check (warehouse_status in ('PENDING_REVIEW', 'APPROVED', 'ON_FLOOR', 'ASSIGNED_TO_INBOUND', 'IN_WAREHOUSE', 'PICKED', 'READY_TO_SHIP', 'PARTIALLY_FULFILLED', 'FULFILLED', 'HOLD')),
  allocation_status text not null default 'UNALLOCATED' check (allocation_status in ('UNALLOCATED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'RELEASED')),
  fulfillment_status text not null default 'PENDING' check (fulfillment_status in ('PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_invoice_lines_unique_line unique (qbo_invoice_id, qbo_line_id)
);

create table if not exists public.shipping_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  source_invoice_id uuid references public.qbo_invoices(id) on delete set null,
  order_number text,
  source_type text not null default 'QBO_INVOICE' check (source_type in ('QBO_INVOICE', 'MANUAL', 'INTERNAL')),
  review_status text not null default 'PENDING_REVIEW' check (review_status in ('PENDING_REVIEW', 'APPROVED', 'HOLD', 'FULFILLED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_orders_unique_invoice unique (source_invoice_id, source_type)
);

create table if not exists public.shipping_order_lines (
  id uuid primary key default gen_random_uuid(),
  shipping_order_id uuid not null references public.shipping_orders(id) on delete cascade,
  qbo_invoice_line_id uuid references public.qbo_invoice_lines(id) on delete set null,
  product_id uuid not null references public.products(id),
  ordered_qty numeric(12,2) not null default 0,
  approved_qty numeric(12,2) not null default 0,
  fulfilled_qty numeric(12,2) not null default 0,
  cancelled_qty numeric(12,2) not null default 0,
  approval_status text not null default 'PENDING_REVIEW' check (approval_status in ('PENDING_REVIEW', 'APPROVED', 'HOLD', 'PARTIAL', 'FULFILLED', 'REMOVED', 'CANCELLED')),
  warehouse_status text not null default 'PENDING_REVIEW' check (warehouse_status in ('PENDING_REVIEW', 'APPROVED', 'ON_FLOOR', 'ASSIGNED_TO_INBOUND', 'IN_WAREHOUSE', 'PICKED', 'READY_TO_SHIP', 'PARTIALLY_FULFILLED', 'FULFILLED', 'HOLD')),
  allocation_status text not null default 'UNALLOCATED' check (allocation_status in ('UNALLOCATED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'RELEASED')),
  fulfillment_status text not null default 'PENDING' check (fulfillment_status in ('PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED')),
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  queue_position_start integer,
  queue_position_count integer,
  approved_at timestamptz,
  source_event_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_order_lines_unique_source unique (shipping_order_id, qbo_invoice_line_id, product_id)
);

create table if not exists public.containers (
  id uuid primary key default gen_random_uuid(),
  container_number text not null unique,
  supplier text,
  order_date date,
  entered_date date,
  deposit_amount numeric(12,2),
  deposit_date date,
  final_payment_amount numeric(12,2),
  final_payment_date date,
  remaining_balance numeric(12,2),
  payment_status text not null default 'Pending' check (payment_status in ('Pending', 'Partially Paid', 'Paid', 'Cancelled')),
  production_status text not null default 'Planned' check (production_status in ('Planned', 'In Production', 'Complete', 'Delayed')),
  lifecycle_status text not null default 'ORDERED' check (lifecycle_status in ('ORDERED', 'PRODUCTION', 'INBOUND', 'RECEIVED', 'CANCELLED')),
  tracking_number text,
  eta_estimated_date date,
  eta_confirmed_date date,
  port_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.container_lines (
  id uuid primary key default gen_random_uuid(),
  container_id uuid not null references public.containers(id) on delete cascade,
  product_id uuid not null references public.products(id),
  ordered_qty numeric(12,2) not null default 0,
  received_qty numeric(12,2) not null default 0,
  on_order_qty numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint container_lines_unique_product unique (container_id, product_id)
);

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  bucket text not null check (bucket in ('SOLD', 'ON_FLOOR', 'ON_ORDER', 'INCOMING_AVAILABLE')),
  delta numeric(12,2) not null,
  before_qty numeric(12,2) not null default 0,
  after_qty numeric(12,2) not null default 0,
  reason text not null,
  source_type text not null check (source_type in ('APPROVAL', 'FULFILLMENT', 'CONTAINER_CREATED', 'CONTAINER_RECEIVED', 'ADJUSTMENT', 'CANCELLATION', 'RECOUNT', 'ALLOCATION', 'RELEASE')),
  source_id uuid,
  source_event_key text,
  container_id uuid references public.containers(id) on delete set null,
  shipping_order_line_id uuid references public.shipping_order_lines(id) on delete set null,
  actor_id uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint inventory_transactions_unique_event unique (source_type, source_event_key)
);

create table if not exists public.inventory_allocations (
  id uuid primary key default gen_random_uuid(),
  shipping_order_line_id uuid not null references public.shipping_order_lines(id) on delete cascade,
  product_id uuid not null references public.products(id),
  container_id uuid references public.containers(id) on delete set null,
  quantity numeric(12,2) not null default 0,
  allocation_status text not null default 'ALLOCATED' check (allocation_status in ('ALLOCATED', 'RELEASED')),
  source_type text not null default 'FLOOR' check (source_type in ('FLOOR', 'CONTAINER')),
  created_at timestamptz not null default now()
);

create table if not exists public.fulfillments (
  id uuid primary key default gen_random_uuid(),
  shipping_order_line_id uuid not null references public.shipping_order_lines(id) on delete cascade,
  fulfilled_qty numeric(12,2) not null default 0,
  fulfilled_at timestamptz not null default now(),
  shipment_number text,
  carrier text,
  tracking_number text,
  reason text,
  actor_id uuid references public.access_users(id) on delete set null,
  source_event_key text,
  created_at timestamptz not null default now(),
  constraint fulfillments_unique_event unique (shipping_order_line_id, source_event_key)
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  actor_id uuid references public.access_users(id) on delete set null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_products_sku on public.products(sku);
create index if not exists idx_product_aliases_product on public.product_aliases(product_id, alias);
create index if not exists idx_qbo_invoices_customer on public.qbo_invoices(customer_id, imported_at desc);
create index if not exists idx_qbo_invoice_lines_product on public.qbo_invoice_lines(product_id, approval_status);
create index if not exists idx_shipping_orders_customer on public.shipping_orders(customer_id, created_at desc);
create index if not exists idx_shipping_order_lines_product on public.shipping_order_lines(product_id, approval_status, queue_position_start);
create index if not exists idx_container_lines_product on public.container_lines(product_id, container_id);
create index if not exists idx_inventory_transactions_product on public.inventory_transactions(product_id, created_at desc);
create index if not exists idx_inventory_allocations_line on public.inventory_allocations(shipping_order_line_id, product_id);
create index if not exists idx_fulfillments_line on public.fulfillments(shipping_order_line_id, fulfilled_at desc);
create index if not exists idx_audit_log_entity on public.audit_log(entity_type, entity_id, created_at desc);

create trigger products_updated_at
before update on public.products
for each row execute function public.update_updated_at_column();

create trigger product_aliases_updated_at
before update on public.product_aliases
for each row execute function public.update_updated_at_column();

create trigger qbo_invoices_updated_at
before update on public.qbo_invoices
for each row execute function public.update_updated_at_column();

create trigger qbo_invoice_lines_updated_at
before update on public.qbo_invoice_lines
for each row execute function public.update_updated_at_column();

create trigger shipping_orders_updated_at
before update on public.shipping_orders
for each row execute function public.update_updated_at_column();

create trigger shipping_order_lines_updated_at
before update on public.shipping_order_lines
for each row execute function public.update_updated_at_column();

create trigger containers_updated_at
before update on public.containers
for each row execute function public.update_updated_at_column();

create trigger container_lines_updated_at
before update on public.container_lines
for each row execute function public.update_updated_at_column();

alter table public.products enable row level security;
alter table public.product_aliases enable row level security;
alter table public.qbo_invoices enable row level security;
alter table public.qbo_invoice_lines enable row level security;
alter table public.shipping_orders enable row level security;
alter table public.shipping_order_lines enable row level security;
alter table public.containers enable row level security;
alter table public.container_lines enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.inventory_allocations enable row level security;
alter table public.fulfillments enable row level security;
alter table public.audit_log enable row level security;

create policy "products_read_all" on public.products
for select to authenticated
using (true);

create policy "products_write_authenticated" on public.products
for all to authenticated
using (true)
with check (true);

create policy "product_aliases_read_all" on public.product_aliases
for select to authenticated
using (true);

create policy "product_aliases_write_authenticated" on public.product_aliases
for all to authenticated
using (true)
with check (true);

create policy "qbo_invoices_read_all" on public.qbo_invoices
for select to authenticated
using (true);

create policy "qbo_invoices_write_authenticated" on public.qbo_invoices
for all to authenticated
using (true)
with check (true);

create policy "qbo_invoice_lines_read_all" on public.qbo_invoice_lines
for select to authenticated
using (true);

create policy "qbo_invoice_lines_write_authenticated" on public.qbo_invoice_lines
for all to authenticated
using (true)
with check (true);

create policy "shipping_orders_read_all" on public.shipping_orders
for select to authenticated
using (true);

create policy "shipping_orders_write_authenticated" on public.shipping_orders
for all to authenticated
using (true)
with check (true);

create policy "shipping_order_lines_read_all" on public.shipping_order_lines
for select to authenticated
using (true);

create policy "shipping_order_lines_write_authenticated" on public.shipping_order_lines
for all to authenticated
using (true)
with check (true);

create policy "containers_read_all" on public.containers
for select to authenticated
using (true);

create policy "containers_write_authenticated" on public.containers
for all to authenticated
using (true)
with check (true);

create policy "container_lines_read_all" on public.container_lines
for select to authenticated
using (true);

create policy "container_lines_write_authenticated" on public.container_lines
for all to authenticated
using (true)
with check (true);

create policy "inventory_transactions_read_all" on public.inventory_transactions
for select to authenticated
using (true);

create policy "inventory_transactions_write_authenticated" on public.inventory_transactions
for all to authenticated
using (true)
with check (true);

create policy "inventory_allocations_read_all" on public.inventory_allocations
for select to authenticated
using (true);

create policy "inventory_allocations_write_authenticated" on public.inventory_allocations
for all to authenticated
using (true)
with check (true);

create policy "fulfillments_read_all" on public.fulfillments
for select to authenticated
using (true);

create policy "fulfillments_write_authenticated" on public.fulfillments
for all to authenticated
using (true)
with check (true);

create policy "audit_log_read_all" on public.audit_log
for select to authenticated
using (true);

create policy "audit_log_write_authenticated" on public.audit_log
for all to authenticated
using (true)
with check (true);
