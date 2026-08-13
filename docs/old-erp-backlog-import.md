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

## Historical Denied And Cancelled Migration (Archive-Only)

This is a separate workflow from active backlog import.

It ingests historical rollback events from the authoritative categorized export and stores them in archive-only tables.

Required source categories and expected counts:

- `setup_rollback`: `353` rows (forensic-only)
- `cancel_deny_rollback`: `88` rows (business denied/cancelled history)

### Destination Tables

- Raw forensic/event storage: `order_history_reason_events_raw`
- Grouped read model for archive UI: `order_history_reason_rollups`

Both tables are isolated from active order and inventory workflow tables.

### Fields Stored

Raw table (`order_history_reason_events_raw`) stores full row fidelity:

- source identity: `source_system`, `source_container`, `source_id`
- business keys: `invoice_number`, `invoice_number_normalized`, `item_code`, `item_code_normalized`
- reason fields: `reason_category`, `reason`, `reason_normalized`
- metadata: `actor`, `adjusted_at`, `created_at`, `import_batch_id`, `imported_at`
- full payload: `raw_payload` (`jsonb`)

Rollup table (`order_history_reason_rollups`) stores grouped archive records:

- grouping keys: `reason_category`, `invoice_number_normalized`, `item_code_normalized`, `reason_normalized`
- display fields: `canonical_invoice_number`, `canonical_item_code`, `canonical_reason`
- history fields: `first_seen_at`, `last_seen_at`, `occurrence_count`, `actors`

### Import Behavior

- Import script: `scripts/import-old-erp-denied-cancelled-history.mjs`
- NPM command: `npm run import:denied-cancelled-history -- --input <path-to-categorized-export.json>`

Behavior guarantees:

- Raw ingestion performs no dedupe and preserves every valid source row.
- `setup_rollback` rows are imported but treated as forensic-only.
- `cancel_deny_rollback` rows are imported and shown in business denied/cancelled archive history.
- Rollups are rebuilt with:
	- `firstSeenAt` = earliest event timestamp per group
	- `lastSeenAt` = latest event timestamp per group
	- `occurrenceCount` = total rows per group

### UI Appearance

`/order-archive` now includes a dedicated **Denied & Cancelled History** section driven by `order_history_reason_rollups` filtered to `reason_category = cancel_deny_rollback`.

It displays:

- invoice number
- item code
- reason
- occurrence count
- first seen / last seen dates
- actors (if present)

### Safety And Non-Impact Guarantee

This migration path does not write to or mutate:

- `shipping_orders`
- `shipping_order_lines`
- `inventory_allocations`
- inventory container/floor stock tables
- any active Service Tracker demand/order state

It is archive-only storage and read-model generation for historical visibility.

### Schema And Route Ownership

- Migration: `supabase/migrations/202608130001_historical_denied_cancelled_archive.sql`
- Import script: `scripts/import-old-erp-denied-cancelled-history.mjs`
- Archive UI route: `src/app/(protected)/order-archive/page.tsx`

## Full InvoiceQueueItems Historical Dry-Run Classifier

Before importing full OLD ERP historical data, run a dry-run classifier against the full Cosmos InvoiceQueueItems export.

- Script: `scripts/classify-old-erp-history-dry-run.mjs`
- NPM command: `npm run report:old-erp-history-dry-run -- --input <full-invoice-queue-items-export.json>`

This dry-run does not write to Supabase. It only produces a JSON report under `tmp/import-reports/`.

Classification intent:

- Preserve DENIED events and denial reasons.
- Treat manual REMOVED reasons like `duplicate`, `dont need`, `fake`, `not a part` as historical outcomes.
- Treat `Replaced by updated QuickBooks invoice` as `SUPERSEDED` (not customer-cancelled).
- Treat `Cleared by invoice CSV import...` or `auditLog.source = invoice-csv-import-replace` as migration artifacts (not customer-cancelled).
- Preserve multi-state history per record by retaining chronological audit events.

Dry-run report includes:

- total raw records
- unique invoices
- denied count
- genuine manual cancellation/removal count
- fulfilled count
- duplicate count
- superseded-by-QBO count
- CSV migration artifact count
- invalid/test/not-a-part count
- records with notes
- records with inventoryRolledBack=true
- unknown/unclassified reasons
- up to 10 representative examples per classification

## Azure Cosmos Read-Only Export

This repo now supports direct read-only export from the legacy Azure Cosmos DB account into local JSON files.

- Script: `scripts/export-azure-cosmos.mjs`
- NPM command: `npm run azure:export -- <ContainerName>`

Supported examples:

- `npm run azure:export -- InvoiceQueueItems`
- `npm run azure:export -- ContainerDrafts`
- `npm run azure:export -- InventoryAdjustments`
- `npm run azure:export -- Products`
- `npm run azure:export -- WarehouseInvoices`

Credential requirements are server-only and must not be committed:

- `OLD_ERP_COSMOS_DATABASE`
- either `OLD_ERP_COSMOS_CONNECTION_STRING`
- or both `OLD_ERP_COSMOS_ENDPOINT` and `OLD_ERP_COSMOS_KEY`

Behavior guarantees:

- Uses `SELECT * FROM c` by default.
- Reads all result pages automatically.
- Saves raw Azure payload unchanged to `tmp/exports/azure-<container>-<timestamp>.json`.
- Writes an export report with total records and pages fetched to `tmp/import-reports/`.
- Performs no updates, inserts, deletes, or stored procedure execution against Cosmos.