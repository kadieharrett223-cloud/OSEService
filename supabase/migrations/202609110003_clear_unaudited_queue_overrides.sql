-- Early imports copied the then-current sequence into the manual override field.
-- A real admin move always has audit metadata, so these unaudited values must not
-- outrank first-payment/invoice dates.
update public.shipping_order_lines
set queue_position_override = null
where queue_position_override is not null
  and queue_position_override_reason is null
  and queue_position_override_at is null
  and queue_position_override_by is null;
