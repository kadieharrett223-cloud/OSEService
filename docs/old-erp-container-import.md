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
- Container line SKUs that do not map to canonical `products.sku` are reported as mapping issues.
- Unmapped SKUs are skipped from `container_lines` insert and must be reviewed/mapped separately.

## Idempotency

Each container gets:

- `source_system = OLD_ERP`
- `source_record_id = <old id>`
- `source_key = OLD_ERP_CONTAINER:<old id>`

`source_key` is unique, so re-running the import does not duplicate containers.

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
