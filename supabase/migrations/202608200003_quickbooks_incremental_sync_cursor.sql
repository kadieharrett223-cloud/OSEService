alter table public.quickbooks_connections
  add column if not exists invoice_sync_cursor_at timestamptz not null default now();
