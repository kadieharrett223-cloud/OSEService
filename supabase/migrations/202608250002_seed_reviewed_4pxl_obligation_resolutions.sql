-- Reviewed business decisions for obligations that must not be recreated by imports or QBO refreshes.
insert into public.reviewed_obligation_resolutions (
  source_record_id,
  qbo_invoice_line_id,
  resolution_type,
  resolution_note
)
select
  seed.source_record_id,
  seed.qbo_invoice_line_id,
  seed.resolution_type,
  seed.resolution_note
from (
  values
    (
      'da25408f-149b-4387-92e9-1591e56c5afb',
      '6f592815-0062-46cd-b308-431ca6392ebc',
      'SKU_CORRECTION',
      'Reviewed 2026-08-25: invoice 11601 is HDMBL-10, not 4PXL-10. The historical 4PXL-10 mapping must not create demand.'
    ),
    (
      '563ea9db-9749-4131-b8c1-e3f1f8de2014',
      '643540d5-6cb4-47e0-885d-f83335eafe2a',
      'DUPLICATE',
      'Reviewed 2026-08-25: invoice 12580 was fulfilled before the re-import. No lift remains owed.'
    ),
    (
      '1752481a-2b8f-4ad2-ae93-efb6c84f24d1',
      null,
      'REPLACED',
      'Reviewed 2026-08-25: invoice 122332 changed from 4PXL-10 to 4PXL-10B before shipment. The original SKU obligation is replaced.'
    )
) as seed(source_record_id, qbo_invoice_line_id, resolution_type, resolution_note)
where not exists (
  select 1
  from public.reviewed_obligation_resolutions existing
  where existing.status = 'ACTIVE'
    and existing.source_record_id is not distinct from seed.source_record_id
    and existing.qbo_invoice_line_id is not distinct from seed.qbo_invoice_line_id
    and existing.resolution_type = seed.resolution_type
);