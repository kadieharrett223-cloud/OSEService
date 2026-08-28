create table if not exists public.historical_qbo_intake_reviews (
  id uuid primary key default gen_random_uuid(),
  qbo_invoice_line_id uuid not null unique references public.qbo_invoice_lines(id) on delete cascade,
  disposition text not null check (disposition in ('APPROVED', 'ALREADY_SATISFIED', 'DUPLICATE', 'CLOSED')),
  review_note text not null default '',
  reviewed_at timestamptz not null default now(),
  reviewed_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger historical_qbo_intake_reviews_updated_at
before update on public.historical_qbo_intake_reviews
for each row execute function public.update_updated_at_column();

alter table public.historical_qbo_intake_reviews enable row level security;

create policy "historical_qbo_intake_reviews_read_authenticated"
on public.historical_qbo_intake_reviews for select
to authenticated using (true);

create policy "historical_qbo_intake_reviews_write_authenticated"
on public.historical_qbo_intake_reviews for all
to authenticated using (true) with check (true);

alter table public.reviewed_obligation_resolutions
  drop constraint if exists reviewed_obligation_resolutions_resolution_type_check;

alter table public.reviewed_obligation_resolutions
  add constraint reviewed_obligation_resolutions_resolution_type_check
  check (resolution_type in ('SKU_CORRECTION', 'REPLACED', 'DUPLICATE', 'HISTORICAL_FULFILLMENT', 'CANCELLED_CLOSED'));