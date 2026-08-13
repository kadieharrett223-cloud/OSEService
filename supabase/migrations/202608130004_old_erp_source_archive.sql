-- Preserve complete OLD_ERP source fidelity without replaying legacy events.
-- One row per source container and source record; raw_payload remains unchanged.

create table if not exists public.old_erp_source_records (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'OLD_ERP_COSMOS',
  source_container text not null,
  source_record_id text not null,
  source_key text not null unique,
  raw_payload jsonb not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  constraint old_erp_source_records_unique_record
    unique (source_system, source_container, source_record_id)
);

create index if not exists idx_old_erp_source_records_container
  on public.old_erp_source_records(source_container, source_record_id);

create index if not exists idx_old_erp_source_records_imported
  on public.old_erp_source_records(imported_at desc);

alter table public.old_erp_source_records enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'old_erp_source_records'
      and policyname = 'old_erp_source_records_read_all'
  ) then
    create policy old_erp_source_records_read_all
      on public.old_erp_source_records
      for select to authenticated
      using (true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'old_erp_source_records'
      and policyname = 'old_erp_source_records_write_authenticated'
  ) then
    create policy old_erp_source_records_write_authenticated
      on public.old_erp_source_records
      for all to authenticated
      using (true)
      with check (true);
  end if;
end
$$;
