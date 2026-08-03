-- Phase 2A: QuickBooks connection state and sync tracking
-- Stores OAuth token material server-side for read-only invoice sync.

create extension if not exists pgcrypto;

create table if not exists public.quickbooks_connections (
  id uuid primary key default gen_random_uuid(),
  realm_id text not null unique,
  environment text not null check (environment in ('sandbox', 'production')),
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  encrypted_access_token text,
  encrypted_refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  connected_by uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_quickbooks_connections_status
  on public.quickbooks_connections(status, updated_at desc);

create index if not exists idx_quickbooks_connections_realm
  on public.quickbooks_connections(realm_id);

drop trigger if exists quickbooks_connections_updated_at on public.quickbooks_connections;
create trigger quickbooks_connections_updated_at
before update on public.quickbooks_connections
for each row execute function public.update_updated_at_column();

alter table public.quickbooks_connections enable row level security;

drop policy if exists "quickbooks_connections_read_all" on public.quickbooks_connections;
drop policy if exists "quickbooks_connections_write_authenticated" on public.quickbooks_connections;

create policy "quickbooks_connections_read_all" on public.quickbooks_connections
for select to authenticated
using (true);

create policy "quickbooks_connections_write_authenticated" on public.quickbooks_connections
for all to authenticated
using (true)
with check (true);
