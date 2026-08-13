-- Archive tables for denied/cancelled historical OLD_ERP reason events.
-- Additive and idempotent: safe to run on existing environments.

create extension if not exists pgcrypto;

create table if not exists public.order_history_reason_events_raw (
	id uuid primary key default gen_random_uuid(),
	import_batch_id text not null,
	source_system text not null,
	source_container text not null,
	source_id text not null,
	invoice_number text,
	invoice_number_normalized text,
	item_code text,
	item_code_normalized text,
	reason_category text not null check (reason_category in ('setup_rollback', 'cancel_deny_rollback')),
	reason text not null,
	reason_normalized text,
	actor text,
	adjusted_at timestamptz,
	created_at timestamptz,
	raw_payload jsonb not null default '{}'::jsonb,
	imported_at timestamptz not null default now()
);

create index if not exists idx_order_history_raw_batch
	on public.order_history_reason_events_raw(import_batch_id, imported_at desc);

create index if not exists idx_order_history_raw_category
	on public.order_history_reason_events_raw(reason_category, imported_at desc);

create index if not exists idx_order_history_raw_invoice_item
	on public.order_history_reason_events_raw(invoice_number_normalized, item_code_normalized);

create index if not exists idx_order_history_raw_source
	on public.order_history_reason_events_raw(source_system, source_container, source_id);

create table if not exists public.order_history_reason_rollups (
	id uuid primary key default gen_random_uuid(),
	reason_category text not null check (reason_category in ('setup_rollback', 'cancel_deny_rollback')),
	invoice_number_normalized text not null,
	item_code_normalized text not null,
	reason_normalized text not null,
	canonical_invoice_number text,
	canonical_item_code text,
	canonical_reason text,
	first_seen_at timestamptz,
	last_seen_at timestamptz,
	occurrence_count integer not null check (occurrence_count >= 1),
	actors jsonb not null default '[]'::jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint order_history_reason_rollups_unique_group
		unique (reason_category, invoice_number_normalized, item_code_normalized, reason_normalized)
);

create index if not exists idx_order_history_rollups_category
	on public.order_history_reason_rollups(reason_category, last_seen_at desc);

create index if not exists idx_order_history_rollups_invoice_item
	on public.order_history_reason_rollups(invoice_number_normalized, item_code_normalized);

drop trigger if exists order_history_reason_rollups_updated_at on public.order_history_reason_rollups;
create trigger order_history_reason_rollups_updated_at
before update on public.order_history_reason_rollups
for each row execute function public.update_updated_at_column();

alter table public.order_history_reason_events_raw enable row level security;
alter table public.order_history_reason_rollups enable row level security;

do $$
begin
	if not exists (
		select 1
		from pg_policies
		where schemaname = 'public'
			and tablename = 'order_history_reason_events_raw'
			and policyname = 'order_history_reason_events_raw_read_all'
	) then
		create policy order_history_reason_events_raw_read_all
		on public.order_history_reason_events_raw
		for select to authenticated
		using (true);
	end if;
end
$$;

do $$
begin
	if not exists (
		select 1
		from pg_policies
		where schemaname = 'public'
			and tablename = 'order_history_reason_events_raw'
			and policyname = 'order_history_reason_events_raw_write_authenticated'
	) then
		create policy order_history_reason_events_raw_write_authenticated
		on public.order_history_reason_events_raw
		for all to authenticated
		using (true)
		with check (true);
	end if;
end
$$;

do $$
begin
	if not exists (
		select 1
		from pg_policies
		where schemaname = 'public'
			and tablename = 'order_history_reason_rollups'
			and policyname = 'order_history_reason_rollups_read_all'
	) then
		create policy order_history_reason_rollups_read_all
		on public.order_history_reason_rollups
		for select to authenticated
		using (true);
	end if;
end
$$;

do $$
begin
	if not exists (
		select 1
		from pg_policies
		where schemaname = 'public'
			and tablename = 'order_history_reason_rollups'
			and policyname = 'order_history_reason_rollups_write_authenticated'
	) then
		create policy order_history_reason_rollups_write_authenticated
		on public.order_history_reason_rollups
		for all to authenticated
		using (true)
		with check (true);
	end if;
end
$$;