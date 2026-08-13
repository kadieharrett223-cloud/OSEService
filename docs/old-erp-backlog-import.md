# OLD_ERP Backlog Import

This import brings approved, unfulfilled Azure backlog demand into the new shipping queue without committing live inventory automatically.

## What It Imports

- `shipping_orders`
- `shipping_order_lines`

Only approved, open demand is imported.

Excluded from active demand:

- removed lines
- denied lines
- fulfilled lines
- shipped lines

## Assignment Rules

The importer preserves Azure assignment history on each `shipping_order_lines` row but does **not** create `inventory_allocations` during import.

Stored reference fields:

- `legacy_floor_assignment`
- `legacy_container_assignment`
- `suggested_assignment_source`
- `suggested_container_id`

Behavior:

- If Azure pointed at a current active container (`ORDERED`, `PRODUCTION`, `INBOUND`), the line gets a suggested container assignment only.
- If the legacy container is missing, received, cancelled, or otherwise inactive, the line stays `UNALLOCATED`.
- If the line is already in warehouse/on-floor state, the importer suggests `FLOOR` instead of inbound container assignment.
- A real inventory commitment only happens when Shipping confirms the assignment in the order workflow, which creates a live `inventory_allocations` row.

## Why This Exists

This prevents backlog imports from double-committing inventory. Open demand still appears in queue and availability views, but container and floor stock are not reduced until a new-ERP assignment is explicitly confirmed.

## Files And Routes

- Import script: `scripts/import-old-erp-backlog.mjs`
- Bulk upload UI: `src/app/(protected)/orders/import/page.tsx`
- Bulk upload action: `src/app/(protected)/orders/import/actions.ts`
- Order confirmation UI: `src/app/(protected)/orders/[id]/page.tsx`
- Assignment action: `src/app/(protected)/orders/actions.ts`
- Queue visibility: `src/app/(protected)/order-queue/page.tsx`
- Inventory visibility: `src/app/(protected)/inventory/page.tsx`
- Schema: `supabase/migrations/202608110001_old_erp_backlog_import_columns.sql`
- Schema follow-up: `supabase/migrations/202608120001_old_erp_backlog_assignment_suggestions.sql`

## Bulk Upload Workflow

Protected staff can now run the backlog import from `/orders/import`.

- Upload a `.json` file or paste raw JSON matching the OLD_ERP queue export shape.
- `Preview Import` stages the payload under the local ignored `imports/backlog/` folder and runs the existing script in preview mode.
- `Apply Import` stages the payload and runs the same script with `--apply`.
- If an invoice number already exists in `shipping_orders`, the bulk upload page pauses before apply and shows the duplicate invoices. Staff can either proceed and reuse/update the existing orders or skip selected duplicate invoices.
- Reports are written to `tmp/import-reports/` and shown back in the UI.

This route is intended for local/sandbox operational use where the workspace can write staged files and report files.

## Import Previous Azure SKU Mappings

If the OLD_ERP backlog payload includes historical `matchedItemCode` values, you can recover those mappings into `product_aliases`.

1. Build a mapping preview CSV from backlog JSON:

```powershell
node scripts/import-old-erp-sku-mapping-from-backlog.mjs --input imports/backlog/manual-import.json --csv-out tmp/azure-previous-sku-mapping.csv
```

2. Review the generated CSV (`sku,canonical_product_sku,notes`).

3. Apply mappings into `product_aliases`:

```powershell
node scripts/import-old-erp-sku-mapping-from-backlog.mjs --input imports/backlog/manual-import.json --csv-out tmp/azure-previous-sku-mapping.csv --apply
```

Behavior notes:

- Uses `itemCode -> matchedItemCode` pairs from the backlog payload.
- Skips alias rows where one alias maps to conflicting canonical SKUs.
- Resolves canonical products by `products.sku` (with compact SKU fallback).

## Risk

Medium.

- Safe for existing order rows because the schema change is additive.
- Import behavior changes for all future Azure backlog runs.
- Existing manually confirmed allocations remain the live source of truth.