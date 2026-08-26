-- Automation remains disabled until the reviewed acceptance set is explicitly executed.
create table if not exists public.qbo_forward_intake_state (
  id boolean primary key default true check (id),
  is_enabled boolean not null default false,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.qbo_forward_intake_state (id, is_enabled)
values (true, false)
on conflict (id) do nothing;

create trigger qbo_forward_intake_state_updated_at
before update on public.qbo_forward_intake_state
for each row execute function public.update_updated_at_column();

alter table public.qbo_forward_intake_state enable row level security;

create policy "qbo_forward_intake_state_read_authenticated"
on public.qbo_forward_intake_state for select
to authenticated using (true);

create policy "qbo_forward_intake_state_write_authenticated"
on public.qbo_forward_intake_state for all
to authenticated using (true) with check (true);