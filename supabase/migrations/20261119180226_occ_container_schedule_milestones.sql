-- Supplier production/China handoff and broker sailing/US port estimates are
-- distinct from OCC's general arrival ETA and actual port arrival date.
alter table public.containers
  add column if not exists rush_status text not null default 'NONE'
    check (rush_status in ('NONE', 'REQUESTED', 'ACCEPTED', 'DECLINED')),
  add column if not exists china_port_handoff_eta_date date,
  add column if not exists china_departure_estimated_date date,
  add column if not exists us_port_eta_date date,
  add column if not exists schedule_source_url text,
  add column if not exists schedule_note text,
  add column if not exists schedule_checked_at timestamptz;
