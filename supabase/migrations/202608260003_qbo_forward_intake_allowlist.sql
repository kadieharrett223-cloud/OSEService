alter table public.qbo_forward_intake_state
  add column if not exists allowed_qbo_invoice_numbers text[] not null default '{}';