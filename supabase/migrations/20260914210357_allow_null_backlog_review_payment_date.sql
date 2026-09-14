-- QuickBooks can report an invoice as paid without returning the original
-- payment timestamp. In that case the intake policy uses the invoice date as
-- its priority fallback, so a backlog-review record must accept a missing
-- payment date rather than aborting the import.
alter table public.qbo_backlog_import_reviews
  alter column first_payment_at drop not null;
