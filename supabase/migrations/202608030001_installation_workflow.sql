-- Phase 3: Installation workflow tables
-- Supports installer submissions with invoice lookup, notes, and photo uploads.

create table if not exists public.installation_jobs (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null,
  quickbooks_invoice_id text,
  quickbooks_customer_id text,
  customer_name text not null,
  company_name text,
  phone text,
  email text,
  shipping_address text,
  summary text,
  status text not null default 'New' check (status in ('New', 'In Progress', 'Completed', 'Blocked')),
  created_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.installation_notes (
  id uuid primary key default gen_random_uuid(),
  installation_job_id uuid not null references public.installation_jobs(id) on delete cascade,
  content text not null,
  created_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.installation_photos (
  id uuid primary key default gen_random_uuid(),
  installation_job_id uuid not null references public.installation_jobs(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  file_size bigint,
  mime_type text,
  uploaded_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_installation_jobs_status_created
  on public.installation_jobs(status, created_at desc);

create index if not exists idx_installation_notes_job
  on public.installation_notes(installation_job_id, created_at desc);

create index if not exists idx_installation_photos_job
  on public.installation_photos(installation_job_id, created_at desc);

create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists installation_jobs_updated_at on public.installation_jobs;
create trigger installation_jobs_updated_at
before update on public.installation_jobs
for each row execute function public.update_updated_at_column();

alter table public.installation_jobs enable row level security;
alter table public.installation_notes enable row level security;
alter table public.installation_photos enable row level security;

drop policy if exists "installation_jobs_read_all" on public.installation_jobs;
drop policy if exists "installation_jobs_write_authenticated" on public.installation_jobs;
drop policy if exists "installation_notes_read_all" on public.installation_notes;
drop policy if exists "installation_notes_write_authenticated" on public.installation_notes;
drop policy if exists "installation_photos_read_all" on public.installation_photos;
drop policy if exists "installation_photos_write_authenticated" on public.installation_photos;

create policy "installation_jobs_read_all" on public.installation_jobs
for select to authenticated
using (true);

create policy "installation_jobs_write_authenticated" on public.installation_jobs
for all to authenticated
using (true)
with check (true);

create policy "installation_notes_read_all" on public.installation_notes
for select to authenticated
using (true);

create policy "installation_notes_write_authenticated" on public.installation_notes
for all to authenticated
using (true)
with check (true);

create policy "installation_photos_read_all" on public.installation_photos
for select to authenticated
using (true);

create policy "installation_photos_write_authenticated" on public.installation_photos
for all to authenticated
using (true)
with check (true);
