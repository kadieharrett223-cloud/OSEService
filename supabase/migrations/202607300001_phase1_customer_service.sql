-- Phase 1: Customer Service Tracking schema
-- Safe default: this migration supports internal tracking only.
-- QuickBooks writeback is intentionally out of scope.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'note_type' and typnamespace = 'public'::regnamespace) then
    create type public.note_type as enum ('internal', 'customer');
  end if;
end
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  company_name text,
  phone text,
  email text,
  shipping_address text,
  quickbooks_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quickbooks_invoices (
  id uuid primary key default gen_random_uuid(),
  quickbooks_invoice_id text not null unique,
  quickbooks_customer_id text,
  invoice_number text not null,
  invoice_date date,
  invoice_total numeric(12,2),
  payment_status text,
  billing_address text,
  shipping_address text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_service_cases (
  id uuid primary key default gen_random_uuid(),
  case_number text not null unique default concat('CASE-', to_char(now(), 'YYYYMMDD'), '-', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))),
  customer_id uuid not null references public.customers(id) on delete restrict,
  quickbooks_invoice_id uuid references public.quickbooks_invoices(id) on delete set null,
  quickbooks_invoice_number text,
  quickbooks_invoice_link text,
  product_model text,
  serial_number text,
  date_of_purchase date,
  issue_reported_at timestamptz not null default now(),
  issue_description text not null,
  assigned_employee_id uuid references public.profiles(id) on delete set null,
  priority text not null default 'Medium' check (priority in ('Low', 'Medium', 'High')),
  status text not null default 'New' check (status in ('New', 'Waiting for Customer', 'Under Review', 'Parts Needed', 'Parts Ordered', 'Parts Shipped', 'Service Scheduled', 'Resolved', 'Closed')),
  internal_notes text,
  customer_facing_notes text,
  final_resolution text,
  closed_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.case_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.customer_service_cases(id) on delete cascade,
  note_type public.note_type not null default 'internal',
  content text not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.case_attachments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.customer_service_cases(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  file_size bigint,
  mime_type text,
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.case_activity (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.customer_service_cases(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  activity_type text not null,
  summary text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.replacement_parts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.customer_service_cases(id) on delete cascade,
  part_name text not null,
  sku text,
  quantity integer not null default 1 check (quantity > 0),
  product_model text,
  supplier text,
  cost numeric(12,2),
  order_date date,
  ordered_by uuid references public.profiles(id) on delete set null,
  shipping_status text,
  carrier text,
  tracking_number text,
  ship_date date,
  delivery_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cases_customer on public.customer_service_cases(customer_id);
create index if not exists idx_cases_status on public.customer_service_cases(status);
create index if not exists idx_cases_priority on public.customer_service_cases(priority);
create index if not exists idx_cases_assigned on public.customer_service_cases(assigned_employee_id);
create index if not exists idx_cases_updated on public.customer_service_cases(updated_at desc);
create index if not exists idx_notes_case on public.case_notes(case_id, created_at desc);
create index if not exists idx_activity_case on public.case_activity(case_id, created_at desc);
create index if not exists idx_parts_case on public.replacement_parts(case_id, created_at desc);

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.log_case_change_activity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.case_activity(case_id, actor_id, activity_type, summary, details)
    values (new.id, new.created_by, 'case_created', 'Case created', jsonb_build_object('status', new.status, 'priority', new.priority));
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      insert into public.case_activity(case_id, actor_id, activity_type, summary, details)
      values (new.id, null, 'status_changed', 'Status updated', jsonb_build_object('from', old.status, 'to', new.status));
    end if;

    if old.assigned_employee_id is distinct from new.assigned_employee_id then
      insert into public.case_activity(case_id, actor_id, activity_type, summary, details)
      values (new.id, null, 'assignment_changed', 'Assignment updated', jsonb_build_object('from', old.assigned_employee_id, 'to', new.assigned_employee_id));
    end if;

    if old.final_resolution is distinct from new.final_resolution and new.final_resolution is not null then
      insert into public.case_activity(case_id, actor_id, activity_type, summary)
      values (new.id, null, 'case_resolved', 'Final resolution updated');
    end if;

    if old.closed_at is distinct from new.closed_at and new.closed_at is not null then
      insert into public.case_activity(case_id, actor_id, activity_type, summary)
      values (new.id, null, 'case_closed', 'Case closed');
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.update_updated_at_column();

drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at
before update on public.customers
for each row execute function public.update_updated_at_column();

drop trigger if exists quickbooks_invoices_updated_at on public.quickbooks_invoices;
create trigger quickbooks_invoices_updated_at
before update on public.quickbooks_invoices
for each row execute function public.update_updated_at_column();

drop trigger if exists cases_updated_at on public.customer_service_cases;
create trigger cases_updated_at
before update on public.customer_service_cases
for each row execute function public.update_updated_at_column();

drop trigger if exists replacement_parts_updated_at on public.replacement_parts;
create trigger replacement_parts_updated_at
before update on public.replacement_parts
for each row execute function public.update_updated_at_column();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user_profile();

drop trigger if exists case_activity_audit on public.customer_service_cases;
create trigger case_activity_audit
after insert or update on public.customer_service_cases
for each row execute function public.log_case_change_activity();

alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.quickbooks_invoices enable row level security;
alter table public.customer_service_cases enable row level security;
alter table public.case_notes enable row level security;
alter table public.case_attachments enable row level security;
alter table public.case_activity enable row level security;
alter table public.replacement_parts enable row level security;

create policy "profiles_select_self" on public.profiles
for select to authenticated
using (id = auth.uid());

create policy "profiles_update_self" on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "customers_read_all" on public.customers
for select to authenticated
using (true);

create policy "customers_write_authenticated" on public.customers
for all to authenticated
using (true)
with check (true);

create policy "quickbooks_invoices_read_all" on public.quickbooks_invoices
for select to authenticated
using (true);

create policy "quickbooks_invoices_write_authenticated" on public.quickbooks_invoices
for all to authenticated
using (true)
with check (true);

create policy "cases_read_all" on public.customer_service_cases
for select to authenticated
using (true);

create policy "cases_insert_authenticated" on public.customer_service_cases
for insert to authenticated
with check (created_by = auth.uid());

create policy "cases_update_authenticated" on public.customer_service_cases
for update to authenticated
using (true)
with check (true);

create policy "cases_delete_authenticated" on public.customer_service_cases
for delete to authenticated
using (true);

create policy "notes_read_all" on public.case_notes
for select to authenticated
using (true);

create policy "notes_insert_authenticated" on public.case_notes
for insert to authenticated
with check (created_by = auth.uid());

create policy "notes_update_authenticated" on public.case_notes
for update to authenticated
using (true)
with check (true);

create policy "attachments_read_all" on public.case_attachments
for select to authenticated
using (true);

create policy "attachments_insert_authenticated" on public.case_attachments
for insert to authenticated
with check (uploaded_by = auth.uid());

create policy "attachments_delete_authenticated" on public.case_attachments
for delete to authenticated
using (true);

create policy "activity_read_all" on public.case_activity
for select to authenticated
using (true);

create policy "activity_insert_authenticated" on public.case_activity
for insert to authenticated
with check (true);

create policy "parts_read_all" on public.replacement_parts
for select to authenticated
using (true);

create policy "parts_write_authenticated" on public.replacement_parts
for all to authenticated
using (true)
with check (true);

insert into storage.buckets (id, name, public)
values ('case-attachments', 'case-attachments', false)
on conflict (id) do nothing;

create policy "case_attachments_select" on storage.objects
for select to authenticated
using (bucket_id = 'case-attachments');

create policy "case_attachments_insert" on storage.objects
for insert to authenticated
with check (bucket_id = 'case-attachments');

create policy "case_attachments_delete" on storage.objects
for delete to authenticated
using (bucket_id = 'case-attachments');
