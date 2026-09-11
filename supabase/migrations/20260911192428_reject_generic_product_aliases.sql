alter table public.product_aliases
  add constraint product_aliases_alias_not_generic_accounting_label
  check (
    upper(regexp_replace(trim(alias), '[^A-Z0-9]+', '', 'g')) not in (
      'NOTE',
      'MISCCHARGE',
      'MISCELLANEOUSCHARGE',
      'SHIPPING',
      'FREIGHT',
      'DELIVERY',
      'DISCOUNT',
      'SALESTAX',
      'TAXADJUSTMENT'
    )
  );
