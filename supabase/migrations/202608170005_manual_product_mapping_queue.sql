create table if not exists public.manual_product_mapping_queue (
  id uuid primary key default gen_random_uuid(),
  source_sku text not null,
  source_description text,
  customer_name text,
  invoice_number text,
  quantity numeric(12,2) not null default 0,
  source_system text not null default 'OLD_ERP_COSMOS',
  source_record_id text,
  current_product_id uuid references public.products(id) on delete set null,
  resolved_product_id uuid references public.products(id) on delete set null,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'IGNORED')),
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manual_product_mapping_queue_unique_source unique (source_system, source_record_id)
);

create index if not exists idx_manual_product_mapping_queue_status
  on public.manual_product_mapping_queue(status, created_at desc);

create trigger manual_product_mapping_queue_updated_at
before update on public.manual_product_mapping_queue
for each row execute function public.update_updated_at_column();

alter table public.manual_product_mapping_queue enable row level security;

create policy "manual_product_mapping_queue_read_authenticated"
on public.manual_product_mapping_queue for select
to authenticated using (true);

create policy "manual_product_mapping_queue_write_authenticated"
on public.manual_product_mapping_queue for all
to authenticated using (true) with check (true);