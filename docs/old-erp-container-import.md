# OLD_ERP ContainerDrafts One-Time Import

This import moves active/open container records from old ERP `ContainerDrafts` into:

- `containers`
- `container_lines`

This is an opening-data import only. It does **not** trigger receiving actions, inventory transactions, order assignment updates, or customer shipment status transitions.

## Eligibility Rules

Import only records where:

- inventory state is `ON_ORDER`
- `removed` is not true
- record contains usable container contents

Exclude records where:

- inventory state is `RECEIVED`
- `removed = true`
- no usable lines (SKU + qty)

## Lifecycle Mapping

- `ON_ORDER + final payment not made` -> `PRODUCTION`
- `ON_ORDER + final payment made/paid` -> `INBOUND`
- if signals are insufficient -> `ORDERED` and add import review note

## Product Mapping Policy

- No silent product creation.
- Container line SKUs map using canonical `products.sku` plus `product_aliases.alias` with normalization (case-insensitive and punctuation-insensitive).
- Unmapped SKUs are skipped from `container_lines` insert and must be reviewed/mapped separately.

## Required Schema (Before Apply)

Migration `supabase/migrations/202608100002_old_erp_container_import_columns.sql` must be applied before running `--apply`.

Required columns:

- `containers.source_system`
- `containers.source_record_id`
- `containers.source_key`
- `container_lines.product_mapping_status`
- `container_lines.source_line_ref`

## Idempotency

Each container gets:

- `source_system = OLD_ERP`
- `source_record_id = <old id>`
- `source_key = OLD_ERP_CONTAINER:<old id>`

`source_key` is unique, so re-running the import does not duplicate containers.

The importer does not fall back to `container_number` idempotency.

## Container Number Resolution

This one-time import resolves container numbers from source fields in this order:

- `parsedContainerNumber`
- `containerNumber` / `container_number` / `number` / `containerNo`
- `originalFilename`
- `notes`

Only the expected active set is accepted:

- `230, 232, 234, 235, 236, 238, 239, 240, 241, 244, 245, 246, 247, 249, 250, 251, 252, 253`

If the eligible candidate set does not reconcile to exactly `18` containers and `714` total units with zero expected-vs-import differences, apply mode is blocked.

## Input Format

The script expects a JSON file containing an array of container draft records.

Accepted top-level keys for record ID include: `id`, `_id`, `containerDraftId`, `draftId`, `recordId`.

Accepted line arrays include: `lineItems`, `items`, `containerLines`, `contents`, `products`, `productLines`.

Accepted line keys include: `sku`/`partNumber` and `orderedQty`/`qty`/`quantity`.

## Run Preview (Required)

Use Node's env-file support so service-role credentials are loaded:

```powershell
node --env-file=.env.local scripts/import-old-erp-containers.mjs --input <path-to-ContainerDrafts.json>
```

Preview output includes:

- `Container # | Supplier | Status | ETA/Port Date | Payment Status | # SKUs | Total Units | Mapping Issues`

A JSON preview report is written to `tmp/import-reports/`.

## Run Apply (After Approval)

```powershell
node --env-file=.env.local scripts/import-old-erp-containers.mjs --input <path-to-ContainerDrafts.json> --apply
```

Apply mode upserts:

- container records by `source_key`
- mapped container lines by `(container_id, product_id)`

and writes an apply report to `tmp/import-reports/`.

If a container has zero mapped lines, it is skipped entirely to prevent empty container shells.
