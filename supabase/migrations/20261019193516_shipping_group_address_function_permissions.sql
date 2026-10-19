-- This helper only parses its caller-supplied JSON; it reads/writes no tables.
-- Allow existing authenticated order writes and service-role invoice syncs to
-- invoke it through the metadata trigger. Anonymous access remains revoked.
grant execute on function public.normalized_invoice_delivery_address(jsonb) to authenticated, service_role;
