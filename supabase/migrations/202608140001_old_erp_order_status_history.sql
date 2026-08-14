-- Preserve historical OLD_ERP order status outcomes without reopening demand.
-- This table is archive/history only and does not participate in inventory availability.

create table if not exists public.old_erp_order_status_history (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'OLD_ERP_COSMOS',
  source_container text not null default 'InvoiceQueueItems',
  source_record_id text not null,
  source_key text not null unique,
  invoice_number text,
  customer_name text,
  item_code text,
  quantity numeric(12,2),
  historical_status text not null check (historical_status in ('ACCEPTED', 'IN_WAREHOUSE', 'SHIPPED', 'FULFILLED', 'DENIED', 'CANCELLED', 'REMOVED', 'OTHER_CLOSED')),
  approval_status text,
  queue_status text,
  warehouse_status text,
  fulfillment_status text,
  payment_status text,
  occurred_at timestamptz,
  notes text,
  raw_payload jsonb not null,
  imported_at timestamptz not null default now(),
  constraint old_erp_order_status_history_unique_source
    unique (source_system, source_container, source_record_id)
);

create index if not exists idx_old_erp_order_history_invoice
  on public.old_erp_order_status_history(invoice_number, customer_name);

create index if not exists idx_old_erp_order_history_status
  on public.old_erp_order_status_history(historical_status, occurred_at desc);

alter table public.old_erp_order_status_history enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'old_erp_order_status_history'
      and policyname = 'old_erp_order_status_history_read_all'
  ) then
    create policy old_erp_order_status_history_read_all
      on public.old_erp_order_status_history
      for select to authenticated
      using (true);
  end if;
end
$$;
