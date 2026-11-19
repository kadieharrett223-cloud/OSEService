-- Staff-facing, read-only copy of verified PO line facts. OSE remains the owner system.
create table public.purchasing_po_snapshots (
  source_po_id uuid primary key,
  po_number text not null unique,
  supplier text not null,
  order_date date,
  source_updated_at timestamptz,
  checked_at timestamptz not null default now(),
  evidence_url text,
  verification_note text
);

create table public.purchasing_po_line_snapshots (
  source_line_id uuid primary key,
  source_po_id uuid not null references public.purchasing_po_snapshots(source_po_id) on delete cascade,
  line_number integer not null,
  sku text,
  description text not null,
  quantity numeric(12,2) not null check (quantity >= 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  checked_at timestamptz not null default now(),
  evidence_url text,
  unique (source_po_id, line_number)
);

create index purchasing_po_line_snapshots_po_idx
  on public.purchasing_po_line_snapshots(source_po_id, line_number);

alter table public.purchasing_po_snapshots enable row level security;
alter table public.purchasing_po_line_snapshots enable row level security;

-- OCC reads these through its authenticated server routes and server-only key.
revoke all on public.purchasing_po_snapshots from anon, authenticated;
revoke all on public.purchasing_po_line_snapshots from anon, authenticated;
