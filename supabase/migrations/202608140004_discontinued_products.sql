-- Discontinued products render in their own section at the bottom of the Inventory page,
-- below Other / Unsorted. Presentation only: quantities and customer queues are unaffected.

insert into public.inventory_display_groups (name, sort_order) values ('Discontinued', 9995)
on conflict (name) do update set sort_order = excluded.sort_order, updated_at = now();

update public.products
set inventory_group = 'Discontinued'
where id in (
  select distinct p.id
  from public.products p
  left join public.product_aliases a on a.product_id = p.id
  where upper(regexp_replace(coalesce(p.sku, ''), '[^A-Za-z0-9]', '', 'g'))
          in ('4PML8A', 'HDMBL8', '4PHR9', '4PHR10X', '4PML9B')
     or upper(regexp_replace(coalesce(a.alias, ''), '[^A-Za-z0-9]', '', 'g'))
          in ('4PML8A', 'HDMBL8', '4PHR9', '4PHR10X', '4PML9B')
);
