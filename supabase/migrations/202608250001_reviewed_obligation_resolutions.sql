-- Reviewed lifecycle decisions survive re-imports and QBO refreshes without mutating source rows.
create table if not exists public.reviewed_obligation_resolutions (
  id uuid primary key default gen_random_uuid(),
  source_record_id text,
  qbo_invoice_line_id text,
  resolution_type text not null check (resolution_type in ('SKU_CORRECTION', 'REPLACED', 'DUPLICATE')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  resolution_note text not null,
  reviewed_at timestamptz not null default now(),
  reviewed_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reviewed_obligation_resolutions_target_required
    check (source_record_id is not null or qbo_invoice_line_id is not null)
);

create index if not exists idx_reviewed_obligation_resolutions_source
  on public.reviewed_obligation_resolutions(source_record_id)
  where status = 'ACTIVE' and source_record_id is not null;

create index if not exists idx_reviewed_obligation_resolutions_qbo_line
  on public.reviewed_obligation_resolutions(qbo_invoice_line_id)
  where status = 'ACTIVE' and qbo_invoice_line_id is not null;

create trigger reviewed_obligation_resolutions_updated_at
before update on public.reviewed_obligation_resolutions
for each row execute function public.update_updated_at_column();

alter table public.reviewed_obligation_resolutions enable row level security;

create policy "reviewed_obligation_resolutions_read_authenticated"
on public.reviewed_obligation_resolutions for select
to authenticated using (true);

create policy "reviewed_obligation_resolutions_write_authenticated"
on public.reviewed_obligation_resolutions for all
to authenticated using (true) with check (true);