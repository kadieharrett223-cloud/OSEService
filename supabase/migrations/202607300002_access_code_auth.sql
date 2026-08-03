-- Phase 1B: Replace Supabase Auth login with app access-code login
-- This migration is designed for databases that already ran 202607300001.

create extension if not exists pgcrypto;

create table if not exists public.access_users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  access_code text not null unique,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.access_login_events (
  id uuid primary key default gen_random_uuid(),
  access_user_id uuid references public.access_users(id) on delete set null,
  full_name_snapshot text,
  success boolean not null,
  login_at timestamptz not null default now()
);

create index if not exists idx_access_login_events_login_at on public.access_login_events(login_at desc);

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists access_users_updated_at on public.access_users;
create trigger access_users_updated_at
before update on public.access_users
for each row execute function public.update_updated_at_column();

-- Keep profiles schema intact to avoid PK/FK dependency breakage.
-- Access-code auth uses access_users and remaps business-table FKs below.

-- Add columns that help map legacy profile-based data to access users
alter table public.profiles
  add column if not exists access_user_id uuid references public.access_users(id) on delete set null;

-- Backfill access users from existing profiles if possible
insert into public.access_users (id, full_name, access_code, is_active)
select
  gen_random_uuid(),
  coalesce(p.full_name, 'Imported User'),
  concat('TEMP-', substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  true
from public.profiles p
where p.access_user_id is null
on conflict do nothing;

update public.profiles p
set access_user_id = au.id
from public.access_users au
where p.access_user_id is null
  and coalesce(p.full_name, '') = au.full_name;

-- Helper to remap FK targets from profiles(id) to access_users(id)
-- If there is no mapping, set nullable columns to null and create_by columns to first active user.
do $$
declare
  fallback_user uuid;
begin
  select id into fallback_user
  from public.access_users
  where is_active = true
  order by created_at asc
  limit 1;

  if fallback_user is null then
    insert into public.access_users (full_name, access_code)
    values ('Default User', concat('TEMP-', substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)))
    returning id into fallback_user;
  end if;

  alter table public.customer_service_cases drop constraint if exists customer_service_cases_created_by_fkey;
  alter table public.customer_service_cases drop constraint if exists customer_service_cases_assigned_employee_id_fkey;

  update public.customer_service_cases c
  set created_by = coalesce(p.access_user_id, fallback_user)
  from public.profiles p
  where c.created_by = p.id;

  update public.customer_service_cases
  set created_by = fallback_user
  where created_by is null;

  update public.customer_service_cases c
  set assigned_employee_id = p.access_user_id
  from public.profiles p
  where c.assigned_employee_id = p.id;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'customer_service_cases_created_by_access_user_fkey'
      and conrelid = 'public.customer_service_cases'::regclass
  ) then
    alter table public.customer_service_cases
      add constraint customer_service_cases_created_by_access_user_fkey
      foreign key (created_by) references public.access_users(id) on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'customer_service_cases_assigned_employee_id_access_user_fkey'
      and conrelid = 'public.customer_service_cases'::regclass
  ) then
    alter table public.customer_service_cases
      add constraint customer_service_cases_assigned_employee_id_access_user_fkey
      foreign key (assigned_employee_id) references public.access_users(id) on delete set null;
  end if;

  alter table public.case_notes drop constraint if exists case_notes_created_by_fkey;
  update public.case_notes n
  set created_by = coalesce(p.access_user_id, fallback_user)
  from public.profiles p
  where n.created_by = p.id;
  update public.case_notes set created_by = fallback_user where created_by is null;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'case_notes_created_by_access_user_fkey'
      and conrelid = 'public.case_notes'::regclass
  ) then
    alter table public.case_notes
      add constraint case_notes_created_by_access_user_fkey
      foreign key (created_by) references public.access_users(id) on delete restrict;
  end if;

  alter table public.case_attachments drop constraint if exists case_attachments_uploaded_by_fkey;
  update public.case_attachments a
  set uploaded_by = coalesce(p.access_user_id, fallback_user)
  from public.profiles p
  where a.uploaded_by = p.id;
  update public.case_attachments set uploaded_by = fallback_user where uploaded_by is null;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'case_attachments_uploaded_by_access_user_fkey'
      and conrelid = 'public.case_attachments'::regclass
  ) then
    alter table public.case_attachments
      add constraint case_attachments_uploaded_by_access_user_fkey
      foreign key (uploaded_by) references public.access_users(id) on delete restrict;
  end if;

  alter table public.case_activity drop constraint if exists case_activity_actor_id_fkey;
  update public.case_activity a
  set actor_id = p.access_user_id
  from public.profiles p
  where a.actor_id = p.id;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'case_activity_actor_id_access_user_fkey'
      and conrelid = 'public.case_activity'::regclass
  ) then
    alter table public.case_activity
      add constraint case_activity_actor_id_access_user_fkey
      foreign key (actor_id) references public.access_users(id) on delete set null;
  end if;

  alter table public.replacement_parts drop constraint if exists replacement_parts_ordered_by_fkey;
  update public.replacement_parts r
  set ordered_by = p.access_user_id
  from public.profiles p
  where r.ordered_by = p.id;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'replacement_parts_ordered_by_access_user_fkey'
      and conrelid = 'public.replacement_parts'::regclass
  ) then
    alter table public.replacement_parts
      add constraint replacement_parts_ordered_by_access_user_fkey
      foreign key (ordered_by) references public.access_users(id) on delete set null;
  end if;
end $$;

-- Disable RLS for app tables because access control moves to server-side code session.
alter table public.profiles disable row level security;
alter table public.customers disable row level security;
alter table public.quickbooks_invoices disable row level security;
alter table public.customer_service_cases disable row level security;
alter table public.case_notes disable row level security;
alter table public.case_attachments disable row level security;
alter table public.case_activity disable row level security;
alter table public.replacement_parts disable row level security;
alter table public.access_users disable row level security;
alter table public.access_login_events disable row level security;

-- Remove old policies that depended on Supabase auth sessions
-- Uses IF EXISTS to support reruns safely.
drop policy if exists "profiles_select_self" on public.profiles;
drop policy if exists "profiles_update_self" on public.profiles;
drop policy if exists "customers_read_all" on public.customers;
drop policy if exists "customers_write_authenticated" on public.customers;
drop policy if exists "quickbooks_invoices_read_all" on public.quickbooks_invoices;
drop policy if exists "quickbooks_invoices_write_authenticated" on public.quickbooks_invoices;
drop policy if exists "cases_read_all" on public.customer_service_cases;
drop policy if exists "cases_insert_authenticated" on public.customer_service_cases;
drop policy if exists "cases_update_authenticated" on public.customer_service_cases;
drop policy if exists "cases_delete_authenticated" on public.customer_service_cases;
drop policy if exists "notes_read_all" on public.case_notes;
drop policy if exists "notes_insert_authenticated" on public.case_notes;
drop policy if exists "notes_update_authenticated" on public.case_notes;
drop policy if exists "attachments_read_all" on public.case_attachments;
drop policy if exists "attachments_insert_authenticated" on public.case_attachments;
drop policy if exists "attachments_delete_authenticated" on public.case_attachments;
drop policy if exists "activity_read_all" on public.case_activity;
drop policy if exists "activity_insert_authenticated" on public.case_activity;
drop policy if exists "parts_read_all" on public.replacement_parts;
drop policy if exists "parts_write_authenticated" on public.replacement_parts;
drop policy if exists "case_attachments_select" on storage.objects;
drop policy if exists "case_attachments_insert" on storage.objects;
drop policy if exists "case_attachments_delete" on storage.objects;
