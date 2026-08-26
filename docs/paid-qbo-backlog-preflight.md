# Paid QBO Backlog Preflight

## Purpose

The protected Settings runner imports only physical QuickBooks invoice lines for invoices first paid or partially paid on or after August 7, 2026. It first classifies every line, then creates only the unambiguous mapped demand lines.

Run it with:

```powershell
npm run preview:qbo-backlog-preflight
```

QuickBooks must be connected through the normal application flow because the runner reads QuickBooks Payment records to determine each invoice's first payment date. Run **Import Qualifying Backlog** from the admin-unlocked Settings page. The protected server action uses the deployment's QBO encryption key; the local read-only command requires the same key and may not be able to decrypt deployed credentials.

Before enabling the runner in production, apply `supabase/migrations/202608260001_qbo_backlog_import_reviews.sql`. It adds first-payment visibility to Product Mappings and a durable manual-duplicate review queue.

## Report classifications

- `IMPORTED`: an eligible, mapped physical line with no exact identity or manual-match conflict. The runner creates an approved QBO order line and records the actual `first_payment_at` on its order.
- `ALREADY PRESENT — SKIPPED`: the exact internal `qbo_invoice_lines.id` is already represented. This identity, not the external QBO line number, is the duplicate key used by ERP order lines.
- `CLOSED — SKIPPED`: the exact line has fulfillment/cancellation terminal evidence or an active reviewed resolution.
- `MANUAL DUPLICATE — REVIEW`: an unlinked order has the same invoice number, customer, canonical product, and quantity. The line is stored in the Settings review queue and creates no demand.
- `UNMAPPED — REVIEW`: the physical QBO line has no canonical mapping. It is stored in Product Mappings with invoice, customer, quantity, and first-payment date, and creates no demand.

Mapped imports recalculate every affected product's queue by the existing first-payment-time and deterministic line-ID tie-breaker. A quantity of two consumes two queue positions. The runner never bases priority on import time, invoice creation date, or order creation date.

## Operational boundary

The runner writes only `shipping_orders`, `shipping_order_lines`, `first_payment_at`, Product Mappings review rows, and manual-duplicate review rows. It does not write `inventory_transactions`, `ON_FLOOR`, shipments, fulfillment quantities, or allocations. Canonical Inventory calculates Sold from the newly active obligations and Available Now from `ON_FLOOR - Sold`.

Reruns are safe: the QBO parent and line uniqueness constraints prevent duplicate obligations, and a uniqueness conflict is treated as already present. Verify the second execution reports zero imports. If a rollback is necessary, retire only the newly created, unfulfilled QBO order lines and their parent when empty, then recalculate their affected queues. Do not compensate with inventory or fulfillment writes.

After an import, run the read-only reconciliation with the run ID displayed on Settings:

```powershell
npm run report:qbo-backlog-import -- --run <run-id>
```

It writes a JSON report under `tmp/import-reports` with the line-level decision and Customer List position, plus each affected SKU's `ON_FLOOR`, Sold, Available, and Customer List quantity before and after the run. Re-run the protected importer and this report once more to demonstrate that the second run adds zero demand.