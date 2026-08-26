alter table public.manual_product_mapping_queue
  add column if not exists first_payment_at timestamptz;

create table if not exists public.qbo_backlog_import_reviews (
  id uuid primary key default gen_random_uuid(),
  qbo_invoice_line_id uuid not null unique references public.qbo_invoice_lines(id) on delete cascade,
  review_type text not null check (review_type in ('MANUAL_DUPLICATE')),
  first_payment_at timestamptz not null,
  invoice_number text,
  customer_name text,
  qbo_sku text,
  source_description text,
  quantity numeric(12,2) not null default 0,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'IGNORED')),
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_qbo_backlog_import_reviews_open
  on public.qbo_backlog_import_reviews(status, first_payment_at);

create trigger qbo_backlog_import_reviews_updated_at
before update on public.qbo_backlog_import_reviews
for each row execute function public.update_updated_at_column();

alter table public.qbo_backlog_import_reviews enable row level security;

create policy "qbo_backlog_import_reviews_read_authenticated"
on public.qbo_backlog_import_reviews for select
to authenticated using (true);

create policy "qbo_backlog_import_reviews_write_authenticated"
on public.qbo_backlog_import_reviews for all
to authenticated using (true) with check (true);