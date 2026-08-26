# OLD_ERP Authoritative Migration (Dry-Run Infrastructure)

This document describes the new preparation pipeline for a full OLD_ERP -> new ERP rebuild in a remote/prod-like Supabase project, without mutating production data.

## Safety Rules

- No Azure mutations: Cosmos access is read-only export.
- No Supabase reset/import apply in this phase.
- Scoped reset utility is preview-only in this version.
- Historical `InventoryAdjustments` are not replayed transaction-by-transaction into current inventory.

## New Migration Files

- `supabase/migrations/202608130001_historical_denied_cancelled_archive.sql`
  - Repaired and recreated as additive/idempotent archive schema.
  - Provides:
    - `order_history_reason_events_raw`
    - `order_history_reason_rollups`

- `supabase/migrations/202608130002_old_erp_product_source_tracking.sql`
  - Adds nullable product source metadata for future scoped reset:
    - `products.source_system`
    - `products.source_record_id`
    - `products.source_key`
  - No backfill labels are applied automatically.

## New Dry-Run Scripts

- `scripts/preview-old-erp-reset.mjs`
  - Identifies OLD_ERP-derived rows in Supabase dependency-safe scope.
  - Reports exact per-table counts for rows that would be backed up/deleted.
  - `--apply` is intentionally blocked in this version.

- `scripts/calculate-old-erp-opening-state.mjs`
  - Computes opening-state tables from full Cosmos exports:
    - `SKU | Warehouse Qty | Incoming Qty | Open Demand | Available Now | Available Incoming`
    - `Container | SKU | Qty | Committed | Available | ETA/Port | Status`
    - Active order-line queue table for invoice/customer/SKU/priority/status/notes.

- `scripts/preview-old-erp-customer-resolution.mjs`
  - Builds deterministic customer match/create plan for active OLD_ERP demand.
  - Uses strongest available identifiers first (QBO/customer id, email, phone, normalized name/address).
  - Does not silently merge ambiguous customers.

- `scripts/report-old-erp-master-reconciliation.mjs`
  - Produces a single pre-apply reconciliation report including:
    - product/alias/unmapped SKU coverage
    - inventory, container, and order demand reconciliation
    - customer resolution status and exceptions
    - ambiguous assignments
    - duplicates/conflicts
    - OLD_ERP reset-preview row counts in Supabase

- `scripts/run-old-erp-migration-orchestrator.mjs`
  - Future one-command orchestrator scaffold.
  - Dry-run only in this version.
  - Executes validation/reconciliation pipeline and emits readiness status.

- `scripts/import-old-erp-products-and-aliases.mjs`
  - Imports OLD_ERP products from Cosmos `Products` export.
  - Sets `products.source_system/source_record_id/source_key` for inserted rows.
  - Upserts `product_aliases` from legacy aliases with `source_ref=OLD_ERP_PRODUCTS_EXPORT`.
  - Existing matching products are not retro-labeled.

- `scripts/apply-old-erp-customers-deterministic.mjs`
  - Inserts only deterministic `CREATE_NEW` customer groups from active OLD_ERP demand.
  - Leaves ambiguous customer groups untouched and reports them for manual review.

- `scripts/import-old-erp-warehouse-fulfillments.mjs`
  - Reads the `WarehouseInvoices` Cosmos export.
  - Links or creates deterministic warehouse customers only when an OLD_ERP order already exists in the target.
  - Records shipped/completed warehouse evidence in `fulfillments`.
  - Does not create `inventory_allocations`.
  - Does not replay `InventoryAdjustments` or write historical adjustment transactions.
  - Leaves unmatched historical warehouse invoices and lines in the exception report.

## NPM Commands

- `npm run preview:old-erp-reset`
- `npm run report:old-erp-opening-state`
- `npm run preview:old-erp-customers`
- `npm run report:old-erp-master-reconciliation`
- `npm run orchestrate:old-erp-dry-run`
- `npm run import:old-erp-products-aliases:preview`
- `npm run import:old-erp-products-aliases:apply`
- `npm run import:old-erp-customers:preview`
- `npm run import:old-erp-customers:apply`
- `npm run import:old-erp-warehouse:preview`
- `npm run import:old-erp-warehouse:apply`

## Paid QuickBooks Order Bridge

The QuickBooks snapshot sync stores customers, invoices, and invoice lines, but those rows do not automatically become shipping review orders. The bridge is:

- `scripts/import-paid-quickbooks-orders.mjs`
- `npm run import:paid-qbo-orders:preview`
- `npm run import:paid-qbo-orders:apply`

Behavior:

- Includes only `Paid` and `Partially Paid` invoices.
- Skips invoices already represented by a `shipping_orders.source_invoice_id`.
- Resolves QBO line SKUs through `products.sku` and `product_aliases.alias`.
- Creates new shipping orders and mapped lines in `PENDING_REVIEW`.
- Does not approve lines, allocate inventory, or change inventory quantities.
- Leaves invoices with unmapped lines in the exception report.

Latest apply result:

- New paid/partially paid orders: `1,017`
- New mapped review lines: `1,641`
- Repeat preview: `1,017` already imported, `0` new orders
- QBO exceptions: `3,352` invoices with no mapped product line

New/Review order handling:

- New/Review cards now include `Accept Order`.
- Accepting an order approves each pending line, sets approved quantity to ordered quantity, moves the line to `READY_TO_SHIP`, and marks the order `APPROVED`.
- Accepting an order does not create inventory allocations or change inventory quantities.
- Existing line-level review remains available for partial/exception handling.

Recent customer/order tracking rule:

- New/Review and the dashboard New Orders metric include only QuickBooks invoices with `Paid` or `Partially Paid` status and an `invoice_date` within the last month.
- On 2026-08-14 the cutoff is 2026-07-14.
- Older imported QBO/OLD_ERP records remain preserved and available in their historical/accepted views; they are not deleted.
- The latest preview found 115 recent paid/partially paid invoices, 95 already represented in the ERP, and no new mapped orders in the current snapshot.
- 20 recent invoices remain exceptions because their lines still lack product mappings.

SKU mapping remains review-gated. The remaining seven OLD_ERP values and QBO invoices with unmapped lines are not silently assigned to products because a guessed mapping would change operational inventory and queue meaning.

## Post-Shutdown QBO Recovery Preview

The August 7, 2026 QBO recovery boundary is separate from historical imports and inventory reconciliation.
The protected, read-only review at `/orders/import-assign` reads actual QuickBooks `Payment` records and
uses each invoice's first payment date. It lists only
eligible invoices missing a canonical ERP order and summarizes eligible, already represented, mapped,
unmapped, and voided counts. The top of `/orders` shows `Import/Assign (N) New Orders` using this same
first-payment rule. The review loads invoices, lines, and ERP parents in pages and resolves customers in
bounded batches so the full dataset can be reviewed without Supabase request-size or default row-limit
failures. The review never creates or updates orders, lines, queues, customer demand, inventory,
allocations, fulfillments, or shipments, and the link has no import or assignment write action.

## Forward QBO Intake

`src/lib/orders/qbo-forward-intake.ts` is the shared decision rule for normal QBO intake.
The read-only `/orders/import-assign` preflight and the post-sync integration use the same exact-QBO-line
identity, payment, mapping, lifecycle-resolution, and manual-duplicate evidence. Eligible physical lines
resolve as `AUTO_IMPORT` only when they are paid or partially paid, mapped, conflict-free, and not already
represented. Service, note, shipping, and accounting-only lines resolve as `NO_INVENTORY_DEMAND`; unmapped
physical lines go to Product Mappings; manual-duplicate evidence goes to the duplicate-review queue.

The sync integration is protected by `qbo_forward_intake_state`, introduced in
`supabase/migrations/202608260002_qbo_forward_intake_state.sql`. It defaults to disabled, so deploying the
code or syncing QBO cannot import demand until an explicit operational enablement decision. Once enabled,
each sync continuously imports every current `AUTO_IMPORT` candidate; the legacy invoice allowlist is no
longer an execution gate. The Settings switch is protected by the existing admin-unlock requirement and is
the rollback control: disable it before the next QBO sync to stop new intake.

The executor creates only approved order demand and preserves `first_payment_at`; it recalculates affected
Customer List positions but never creates an allocation, fulfillment, shipment, or inventory transaction.
In particular, it never changes `ON_FLOOR`. Exact QBO invoice and line identities make repeated syncs
idempotent. Mapping and manual-duplicate candidates are recorded in their existing review queues rather
than being imported.

Routine QBO syncs use the stored sync cursor for invoice and customer snapshots and limit forward-intake
payment reads to the August 7, 2026 recovery boundary. This avoids replaying the historical QBO directory
and payment ledger during normal operation. The Orders page links to Import/Assign as the explicit review
surface; it does not call QBO or execute the intake preflight while rendering.

## Historical OLD_ERP Order Status Archive

Historical InvoiceQueueItems outcomes are imported separately from live shipping demand with:

- `supabase/migrations/202608140001_old_erp_order_status_history.sql`
- `scripts/import-old-erp-order-status-history.mjs`
- `npm run import:old-erp-order-history:preview`
- `npm run import:old-erp-order-history:apply`

The current status model treats shipped and fulfilled as one completed shipment state. The preview against the current 6,015-row Cosmos export classified:

- `SHIPPED`: 2,278
- `REMOVED`: 3,600
- `CANCELLED`: 89
- `DENIED`: 29
- `ACCEPTED`: 19

These rows are archive/history only. They do not reopen customers, create active demand, create allocations, or replay inventory adjustments. `New / Review` means a recent order has not entered the ERP workflow; `Accepted` means accepted and waiting to ship; `In Warehouse` means at least one live product line is in warehouse; `Shipped` includes both shipped and fulfilled historical outcomes.

## Final Dry-Run Status (2026-08-13)

The latest complete reconciliation is:

- Readiness: `BLOCKED`
- Unmapped SKUs: `16`
- Ambiguous customer groups: `24`
- Order lines without deterministic customer resolution: `52`

These exceptions are intentionally not auto-resolved. The remaining SKU values include deleted/variant/description-style legacy codes, and the customer groups have conflicting identity evidence. They require explicit mapping decisions before a clean rebuild can be considered complete.

The scoped reset preview now includes the complete raw archive. The latest preview identifies `20,337` OLD_ERP-derived rows across `13` tables, including `18,136` rows in `old_erp_source_records`. This is a preview count only; no reset or delete was executed.

The legacy alias recovery pass found five deterministic mappings, applied one new alias, and left existing aliases unchanged. The importer uses insert-only behavior because the current `product_aliases` update trigger references a missing `updated_at` column; this avoids mutating existing mappings while that schema defect is addressed.

## Opening Inventory Synchronization

The opening inventory synchronizer is:

- `scripts/sync-old-erp-opening-inventory.mjs`
- `npm run sync:old-erp-opening-inventory:preview`
- `npm run sync:old-erp-opening-inventory:apply`

It uses the latest OLD_ERP `Products.onFloor`/`onHand` values as the validated opening floor baseline and writes only idempotent `RECOUNT` rows. It does not replay `InventoryAdjustments`. Incoming inventory remains derived from active `container_lines` and containers.

The latest conflict-aware preview matches OLD_ERP and Supabase at `530,335` floor units across `244` unambiguous canonical products with zero remaining delta. It intentionally excludes `18` canonical targets where multiple legacy operational item codes resolve to one target product; those conflicts represent `574` source units and require explicit product identity decisions before complete inventory parity can be claimed.

## Order Parity Report

The read-only order parity command is:

- `scripts/report-old-erp-order-parity.mjs`
- `npm run report:old-erp-order-parity`

Latest result across all `6,015` OLD_ERP InvoiceQueueItems rows:

- History rows: `6,015`
- Live shipping lines: `2,534`
- Fully matched source/history/live rows: `892`
- Expected history-only rows: `5,109`
- Live-only QuickBooks rows: `1,641`
- Missing live lines: `13`, all tied to unresolved SKU mappings
- Remaining field mismatch: `1` customer name variant (`Shrewsbury` versus `Russell Shrewsbury`)

The 204 directly evidenced priority mismatches were synchronized from OLD_ERP into matched live lines. The parity report does not mutate data; it distinguishes expected historical absence from actual missing operational order data.

## Current Warehouse Orders Report

The read-only Cosmos warehouse report is:

- `scripts/report-old-erp-current-warehouse-orders.mjs`
- `npm run report:old-erp-current-warehouse`

It includes only records with `approvalStatus=APPROVED`, `queueStatus=APPROVED`, positive quantity, no terminal/removed state, and an actual warehouse signal observed in the source: `warehouseStatus=ACTIVE` or `floorAssignment.type=floor`.

Latest fresh Cosmos result:

- Current warehouse orders: `26`
- Current warehouse lines: `62`
- Current warehouse units: `63`
- Ambiguous approved/open records: `833`

Exports:

- `tmp/import-reports/old-erp-current-warehouse-orders-latest.json`
- `tmp/import-reports/old-erp-current-warehouse-orders-latest.csv`

The ambiguous set is kept separate because it is approved/open but has no `ACTIVE` warehouse status or floor assignment. It must not be silently presented as physically in warehouse.

## Accepted Customer Transfer

Customers attached to accepted/approved or warehouse-state OLD_ERP rows can be transferred with:

- `scripts/transfer-old-erp-accepted-customers.mjs`
- `npm run transfer:old-erp-accepted-customers:preview`
- `npm run transfer:old-erp-accepted-customers:apply`

The first apply transferred `617` deterministic customer groups and matched `445` existing customers from `4,158` accepted/warehouse source lines. Denied/removed-only records were excluded.

The follow-up preview found `407` source groups still needing identity deduplication and `7` ambiguous groups. No second apply was performed because those groups need stronger identity matching before they can be safely merged or created. The apply report is `tmp/import-reports/old-erp-accepted-customers-2026-08-14T16-36-12-255Z.json`.

The product queue invariant is now wired through order acceptance, Shipping Review approval/hold, fulfillment, shipment, and manual inventory assignment. The remote database must have `202608140002_product_queue_position_overrides.sql` applied before the new override columns and automatic queue recalculation can run.

## Warehouse Order State Transfer

The old warehouse-page state is synchronized with:

- `scripts/sync-old-erp-order-operational-state.mjs`
- `npm run sync:old-erp-order-state:preview`
- `npm run sync:old-erp-order-state:apply`

For matched live OLD_ERP lines, the sync transfers:

- approval status
- warehouse status (`IN_WAREHOUSE`, `PICKED`, `READY_TO_SHIP`, `FULFILLED`, and other supported states)
- fulfillment status
- priority
- queue position
- expected date
- fulfillment method/shipping method
- floor/container assignment evidence
- legacy status fields used for audit

It then recomputes the parent order status and priority. It does not create allocations or replay inventory adjustments.

Latest result:

- Matched live lines updated: `893`
- Parent orders recomputed: `414`
- Repeat preview pending changes: `0`
- Historical source rows intentionally not live: `5,122`

## Data Flow

1. Cosmos exports are read from `tmp/exports` (or freshly exported with `azure:export`).
2. Opening-state calculator computes warehouse/incoming/demand and assignment trust classification.
3. Customer resolver computes deterministic match/create/ambiguous outcomes.
4. Reset preview computes exact OLD_ERP scoped-row impact in Supabase.
5. Master reconciliation merges all validation into one report and readiness gate.
6. Orchestrator dry run wires the future full sequence without mutating data.

## Risk

Medium.

- Infrastructure is additive and dry-run only.
- Readiness depends on source quality, SKU mappings, customer resolution ambiguity, and assignment trust.
- Apply mode is intentionally not enabled here.
