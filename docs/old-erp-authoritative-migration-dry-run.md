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

## NPM Commands

- `npm run preview:old-erp-reset`
- `npm run report:old-erp-opening-state`
- `npm run preview:old-erp-customers`
- `npm run report:old-erp-master-reconciliation`
- `npm run orchestrate:old-erp-dry-run`

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
