-- Allows durable, source-specific historical fulfillment facts to survive re-imports.
alter table public.reviewed_obligation_resolutions
  drop constraint if exists reviewed_obligation_resolutions_resolution_type_check;

alter table public.reviewed_obligation_resolutions
  add constraint reviewed_obligation_resolutions_resolution_type_check
  check (resolution_type in ('SKU_CORRECTION', 'REPLACED', 'DUPLICATE', 'HISTORICAL_FULFILLMENT'));