# Inventory Read Model

## Why this exists

The Inventory page must reproduce the OLD_ERP product/customer/inventory model. Previously it derived
everything from the `products` table and grouped duplicates only at render time, which double counted
container supply and produced customer positions that collided across duplicate legacy identities.

The read model now assembles each row from four authoritative domains joined by a **canonical SKU key**.

## Canonical SKU key

`normalizeSkuKey(value)` uppercases and strips non-alphanumerics. The display SKU is the first
non-numeric product alias (the operational item code, e.g. `4PHR-9X`), falling back to `products.sku`
(often an internal code like `000012`). Every domain is aggregated under this key, so the legacy
duplicate identities (`4PHR-9X` and `000012`) collapse into one row.

## Domains

| Domain | Source | Rule |
| --- | --- | --- |
| Product identity | `products` + `product_aliases` | Catalog only; defines which rows appear |
| On floor | `inventory_transactions` where `bucket = 'ON_FLOOR'` | Physical warehouse stock. **Never derived from demand.** |
| Open demand + customer list | Canonical physical QBO item plus its sibling `shipping_order_lines` | `SUM(max(0, canonical ordered - canonical legitimate fulfilled))`; one list row per order line, never per unit |
| Incoming + ETA | `container_lines` joined to `containers` with lifecycle ORDERED/PRODUCTION/INBOUND | `SUM(on_order_qty - received_qty)`; ETA read directly from the container record |
| Packaged freight dimensions | `old_erp_source_records.raw_payload` where `source_container = 'Products'` | Read-only `lengthInches`, `widthInches`, `heightInches`, and `weightLbs`, matched by canonical SKU; assembled product-description measurements are never used |

### Container deduplication

Container supply is recorded per **part number**, so it belongs to the canonical SKU rather than to a
single `product_id`. The legacy import wrote the same container line under each duplicate product
identity, so merging by container number uses `Math.max` rather than a sum. Summing produced exactly
2x the true incoming quantity.

### Forecast coverage versus persisted allocation

Container detail and Inventory forecast coverage use the shared `canonicalProductSkuKey()` utility
in `src/lib/products/canonical-sku.ts`. It prefers a non-numeric operational product alias before
normalizing manufacturer prefixes, so supply on a recycled product ID and canonical Customer List
demand on a different product ID are resolved together even when one stored product SKU is a legacy
numeric identifier. Forecast demand is
loaded from `loadCanonicalCustomerQueue()` and passed to the quantity-aware
`resolveProductCoverage()` solver, which covers Warehouse first and then active containers in ETA
order.

This is a read-only projection. `Forecast Coverage` and `Forecast: Container ...` do not create
or alter `inventory_allocations`. `Actually Assigned` and `Persisted: ...` remain derived only
from live allocation rows. Receiving a container still records physical receipt quantities and
audit history only; it does not automatically allocate inventory or update warehouse status.
Before receipt, Container Product Lines show `Forecast Allocated` and `Forecast Available` from
that same canonical projection. After receipt, their labels and values revert to actual received
quantity coverage.

Orders detail resolves QuickBooks labels such as `4PML-9 (deleted-1)` through the same deleted-SKU
candidate sequence used during QuickBooks intake before loading Warehouse and incoming supply. A
deleted invoice label therefore cannot bypass an active product alias and incorrectly render an
otherwise covered customer line as waiting.

## Inventory math

```
committed_floor = max(confirmed floor allocations, min(open_demand, on_floor))
available_now   = max(0, on_floor - committed_floor)
projected       = max(0, on_floor + incoming - open_demand)
uncovered       = max(0, open_demand - on_floor - incoming)
```

`committed_floor` encodes the OLD_ERP `Available = On Floor - Sold` rule: unallocated open demand
still consumes floor stock. All values are clamped, so physical inventory is never negative.

`next ETA` is the earliest active container with remaining units, taken straight from the container
record (no recomputation).

### Customer-list invariant

Customer List membership, Sold/Committed, queue demand, and availability coverage begin with the
canonical physical remaining quantity for the logical invoice and require current operational
activation. A logical order is activated when its parent left `PENDING_REVIEW`, or reconciliation
left an approved open line. This keeps dormant historical imports as evidence without counting them
as current customer demand. Active QBO and OLD_ERP sibling parents are resolved together by
`source_invoice_id`, so a completed QBO physical line suppresses a stale OLD_ERP sibling that still
says `IN_WAREHOUSE` or carries queue metadata. Warehouse status, queue positions, and allocations
are display or operational metadata only; none may resurrect a line whose canonical remaining
demand is zero.

The read-only production audit is:

```powershell
node --env-file=.env.local scripts/audit-inventory-customer-demand.mjs
```

It writes `tmp/import-reports/inventory-customer-demand-audit.json`, classifying stale completed
demand, missing open demand, queue-count mismatches, stale warehouse state, and parent-evidence
conflicts. It proposes no writes. Invoice `122353` (Joshua Schaaf) is the regression case: its
`4PXL-10` canonical remaining quantity is zero, so it must have no Customer List row, queue
position, or Sold/Committed contribution.

`scripts/audit-current-operational-inventory-demand.mjs` performs the matching all-SKU read-only
comparison. It reports any mapped SKU where projected committed demand differs from current
operational canonical demand, and separately lists active canonical items that cannot render
because they have no physical ERP product mapping. It never writes inventory, order, queue,
fulfillment, container, or QBO data.

## Verification

`scripts/debug-inventory-read-model.mjs` is a read-only harness that prints the source rows feeding
product identity, on floor, open demand, incoming, customer list, and next ETA for given SKUs, from
both the OLD_ERP Cosmos exports in `tmp/exports/` and Supabase, then compares them.

```powershell
node scripts/debug-inventory-read-model.mjs 4032S 4PHR-9X 2PBP-8
```

### Physical reconciliation

`scripts/audit-sku-physical-reconciliation.mjs` is a read-only physical ledger. It starts from a
trusted final OLD ERP opening recount, adds received-container and legitimate adjustment events, and
subtracts only warehouse-eligible fulfilled units. Explicit `DROPSHIP` and `OTHER` fulfillment is
shown as zero physical effect; blank source is warehouse-eligible only when direct fulfillment or
shipment proof exists. Historical `SOLD` transactions are never used as shipment truth.

```powershell
node --env-file=.env.local scripts/audit-sku-physical-reconciliation.mjs 4PXL-10
node --env-file=.env.local scripts/audit-sku-physical-reconciliation.mjs --all
```

The single-SKU report is `tmp/import-reports/4pxl-10-physical-reconciliation.json`; `--all` writes
`tmp/import-reports/all-sku-physical-reconciliation.json` with per-identity ledgers and ranked
physical discrepancies. A product is rankable only with one opening recount or a final explicit
`OLD_ERP_OPENING_CORRECTION`. Other multi-recount identities are `BASELINE_AMBIGUOUS` and must be
explained before any correction. No audit command writes inventory, orders, fulfillment, or queue
metadata.

The `4PXL-10` reconciliation additionally accepts the authoritative date-only OLD ERP inventory
snapshot supplied for August 7, 2026: `32` on floor, `22` outstanding demand, and `33` incoming.
The 33 incoming units are reported separately by container and affect physical stock only through a
subsequent `CONTAINER_RECEIVED` event; an open `PRODUCTION` or `INBOUND` container remains incoming.

To explain a raw `ON_FLOOR` difference without mutating inventory, run:

```powershell
node --env-file=.env.local scripts/audit-4pxl-on-floor-discrepancy.mjs
```

The report classifies each `ON_FLOOR` transaction using its linked fulfillment or shipment business
date, rather than its ledger-posting timestamp. It writes a no-apply recount proposal only when the
authoritative baseline and post-baseline physical events explain the difference.

### Legacy field semantics (verified against the exports)

- Container lines live in `items[]` / `onOrderAppliedItems[]` as `{ partNumber, qty }` — there is no
  received quantity. A container is incoming while `inventoryStatus = 'ON_ORDER'` and `removed !== true`.
  The ETA is the container `portDate`; the container number is `parsedContainerNumber`.
- Queue items do **not** populate `fulfillmentStatus`. Open demand is `approvalStatus = 'APPROVED'`
  AND `removed !== true` AND no `fulfilledAt` AND `queueStatus` not in
  (REMOVED, FULFILLED, CANCELLED, COMPLETED, SHIPPED).

### Current parity

| SKU | on_floor | open_demand | incoming | next ETA |
| --- | --- | --- | --- | --- |
| 4032S | 1 = 1 | 4 = 4 | 6 = 6 | container 236 (no ETA in source) |
| 4PHR-9X | 11 = 11 | 52 = 52 | 69 = 69 | container 230 @ 2026-08-06 |
| 2PBP-8 | 13 = 13 | 9 old / 10 new | 8 = 8 | container 247 (no ETA in source) |

`2PBP-8` carries one extra open line in the new ERP because live QuickBooks orders continued after the
Cosmos export snapshot was taken. `HL-2PBP-8` does not exist in either system; its canonical SKU is
`2PBP-8`.

## Package dimensions

The Inventory list renders preserved packaged freight measurements as subtle text beneath the product
name. It does not write product data or infer package measurements from lift descriptions. Complete
length, width, and height render as dimensions; a valid weight can render by itself when dimensions
are incomplete. Multi-carton shipment support requires authoritative source data before it can be
displayed.

The server normalizes `lengthInches`, `widthInches`, `heightInches`, and `weightLbs` into a small
SKU-to-package map cached for five minutes. Inventory rows receive only their own package object;
the table has no package button, URL state, navigation, client state, or refetch for this text.

### Performance profile

The 2026-08-24 read-only baseline found 298 active products, 419 aliases, 419 inventory
transactions, 57 container lines, 930 eligible order lines, and 300 OLD_ERP Product source records.
The seven parallel base reads completed in approximately 423 ms; the full OLD_ERP package-payload
read was on the critical path. The package lookup cache removes that source-record read from
subsequent Inventory renders, reducing the base request fan-out from seven to six queries.

Orders and its Warehouse tab share the existing 60-second Orders projection cache. ERP Health is
intentionally uncached because it is a live diagnostic view; it currently reads its 500-order health
graph and the active source-linked parent set. Its data-preservation diagnostics must remain correct
before any caching or pagination change is considered.

## Known gaps

- Containers imported without a port date show `Pending` for ETA, matching the empty source value.
- 18 canonical products still have conflicting legacy SKU identities (574 units) excluded from the
  opening balance; these need a business decision before they can be merged.

### Canonical Sibling Resolution

The Inventory projection preserves the established open-line demand population, then resolves
sibling parent evidence by logical invoice before building Customer List, Sold/Committed, and queue
values. A fulfilled canonical QBO physical line always takes precedence over an open OLD_ERP
sibling, so stale sibling metadata cannot resurrect a completed customer obligation.

`getCanonicalOpenDemandLines` in `src/lib/demand/product-demand.ts` is the shared ordered pipeline:
it shares proven fulfillment across linked lines, suppresses completed QBO line and invoice siblings,
deduplicates one logical obligation, then retains only active demand. Inventory uses that exact
population before creating both the Sold/Available totals and Customer List rows; the final
invoice-level Customer List merge remains in `mergeOpenCustomerDemand`.

### Shared Customer Queue Projection

`src/lib/demand/canonical-customer-queue-loader.ts` is the read-only server loader for the active
Customer List population. It preserves the Inventory physical-QBO reconciliation, fulfilled-line
evidence, completed QBO sibling suppression, duplicate/cancelled/voided parent exclusions, reviewed
resolutions, manual-mapping exclusions, product aliases, and invoice-level merging. It then sends
each product's surviving rows to `src/lib/demand/canonical-customer-queue.ts`, which sorts by
`first_payment_at`, then deterministic fallbacks, and assigns compact quantity-aware position ranges.

Both `/inventory` and `/orders/[id]` use this loader. `shipping_order_lines.queue_position_start`
is retained as historical compatibility metadata only and must never be shown as the authoritative
Customer List position. Order Detail leaves its narrower supply-coverage query unchanged and uses
the shared loader only for the Customer Queue position.

The regression case is QBO invoice `127086`, line
`03ec2e30-1ea9-41f2-8e77-5fa0db138e9d` (`000173` / `4PXL-10`): both pages must calculate position
`#7`; the stale stored value is `#16`. Any queue change must pass a read-only all-SKU parity audit
showing zero mismatches between the Inventory and Order Detail calculated positions, with no writes
to orders, demand, fulfillment, allocations, inventory transactions, or queue metadata.

### Missing First-Payment Audit

`/settings/qbo-first-payment-audit` is an admin-unlocked, protected, read-only audit for active
canonical Paid and Partially Paid Customer List rows whose ERP parent has no `first_payment_at`.
It calls the established QuickBooks integration and derives the earliest linked QBO `Payment.TxnDate`;
it never substitutes invoice dates or ERP creation timestamps. It reports the current and projected
per-product canonical position, payment-transaction count, and `VERIFIED`, `MULTIPLE_PAYMENTS`, or
`UNVERIFIED` evidence status. The JSON export is protected by the same employee session and admin
unlock.

The audit refuses to refresh an expired QBO token. This preserves its read-only contract: it cannot
write QuickBooks connection state, ERP timestamps, queue positions, demand, fulfillment, inventory,
allocations, shipments, mappings, or resolutions. An approved backfill is a separate operation.

### Invoice-Date Queue Fallback

Historical first-payment backfill is cancelled. The Customer List priority rule is read-model-only:
use `first_payment_at` when present; otherwise use the related QBO invoice date; otherwise use the
existing deterministic order-creation fallback. An invoice date is never written into or labelled as
`first_payment_at`.

`/settings/queue-priority-preview` is an admin-unlocked, read-only all-SKU comparison of the prior
first-payment-or-created ordering against the invoice-date fallback. Inventory Customer Lists, Order
Detail queue positions, and Customer List CSV exports consume the same shared canonical projection.
When the fallback is used, Inventory displays `Priority Date` and `Invoice date fallback`, rather
than falsely displaying the value as `First Paid`. The rule does not change queue membership, Sold
quantities, stored queue positions, inventory, fulfillment, shipments, allocations, mappings,
resolutions, QBO intake, or historical order data.

### Reviewed terminal resolutions

`reviewed_obligation_resolutions` is an append-only reviewed lifecycle ledger for source evidence
that cannot safely be inferred from a later import or QuickBooks refresh. An active `SKU_CORRECTION`,
`REPLACED`, or `DUPLICATE` resolution targets a `source_record_id`, a `qbo_invoice_line_id`, or both.
The Inventory route loads these active rows and excludes the target plus any bridged sibling before
the shared fulfillment, completed-QBO, dedupe, and open-demand stages. Revoking a resolution restores
the normal evidence-based calculation. The ledger changes `Sold` and Customer List membership only;
it never writes or derives `ON_FLOOR`, Incoming, container quantities, or inventory transactions.

The initial reviewed decisions are invoice `11601` (`SKU_CORRECTION`: HDMBL-10, not 4PXL-10),
`12580` (`DUPLICATE`: fulfilled before re-import), and `122332` (`REPLACED`: 4PXL-10 changed to
4PXL-10B before shipment). A later QBO refresh cannot reopen those old obligations.

### Frozen-proof reconciliation preview

Use the frozen SKU proof artifacts only as an allowlist for targeted order-demand investigation:

```powershell
node --env-file=.env.local scripts/preview-frozen-inventory-demand-reconciliation.mjs
```

The command writes `tmp/import-reports/frozen-inventory-demand-reconciliation-preview.json` and
the matching Markdown summary. It lists every live stale line attached to an invoice explicitly
closed in a fully reconciled proof, its current statuses, quantity effect, and proof source. It is
read-only: it cannot write inventory transactions, physical ON_FLOOR quantities, shipment or receipt
events, container history, or order lifecycle statuses. `4PHDXL-12` is always excluded because its
physical baseline remains unresolved.
