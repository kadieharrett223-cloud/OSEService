-- Presentation-only display ordering for the Inventory page.
-- Reproduces the OLD_ERP Lift Availability grouping and sequence (Products.category / Products.sortOrder).
-- Does not affect inventory quantities, demand, or customer queues.

alter table public.products
  add column if not exists inventory_group text,
  add column if not exists inventory_sort_order integer;

create table if not exists public.inventory_display_groups (
  name text primary key,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_products_inventory_display_order
  on public.products(inventory_group, inventory_sort_order);

-- Group sequence derived from the lowest legacy sortOrder observed in each category,
-- so the page opens in the same order the Lift Availability page used.
-- Gaps of 10 leave room to insert a group without renumbering.
insert into public.inventory_display_groups (name, sort_order) values
  ('2-Post Lifts', 10),
  ('4-Post Lifts', 20),
  ('Scissor Lifts', 30),
  ('Accessories', 40),
  ('Alignment Equipment', 50),
  ('Other Items', 60),
  ('Motors', 70),
  ('Center Jacks', 80),
  ('Ramps, Panels & Platforms', 90),
  ('Oil & Epoxy', 100),
  ('Oil Drains', 110),
  ('Truck Extensions, Frame Cradles, & Feet', 120),
  ('Tool, Jack & Drip Trays Hitch Rests', 130),
  ('Jacks & Jack Stands', 140),
  ('Arms & Posts', 150),
  ('Cylinders, Hoses, & Seal Kits', 160),
  ('Hardware, Cables, & Spare Parts', 170),
  ('Neon Signs', 180),
  ('Metal Signs', 190),
  ('Other / Unsorted', 9990)
on conflict (name) do update set sort_order = excluded.sort_order, updated_at = now();
