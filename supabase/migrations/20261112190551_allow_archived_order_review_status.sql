-- The order read models already support ARCHIVED as distinct from fulfilled/cancelled.
-- Keep the historical invoice and fulfillment evidence intact when retiring a dormant import.
alter table public.shipping_orders drop constraint shipping_orders_review_status_check;
alter table public.shipping_orders add constraint shipping_orders_review_status_check
  check (review_status in ('PENDING_REVIEW', 'APPROVED', 'HOLD', 'FULFILLED', 'CANCELLED', 'ARCHIVED'));
