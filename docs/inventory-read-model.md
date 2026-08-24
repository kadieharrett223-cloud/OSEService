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
| Open demand + customer list | `shipping_order_lines` (`approval_status` in APPROVED/PARTIAL/FULFILLED, `fulfillment_status <> CANCELLED`) | `SUM(approved_qty - fulfilled_qty)`; one list row per order line, never per unit |
| Incoming + ETA | `container_lines` joined to `containers` with lifecycle ORDERED/PRODUCTION/INBOUND | `SUM(on_order_qty - received_qty)`; ETA read directly from the container record |
| Packaged freight dimensions | `old_erp_source_records.raw_payload` where `source_container = 'Products'` | Read-only `lengthInches`, `widthInches`, `heightInches`, and `weightLbs`, matched by canonical SKU; assembled product-description measurements are never used |

### Container deduplication

Container supply is recorded per **part number**, so it belongs to the canonical SKU rather than to a
single `product_id`. The legacy import wrote the same container line under each duplicate product
identity, so merging by container number uses `Math.max` rather than a sum. Summing produced exactly
2x the true incoming quantity.

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

## Verification

`scripts/debug-inventory-read-model.mjs` is a read-only harness that prints the source rows feeding
product identity, on floor, open demand, incoming, customer list, and next ETA for given SKUs, from
both the OLD_ERP Cosmos exports in `tmp/exports/` and Supabase, then compares them.

```powershell
node scripts/debug-inventory-read-model.mjs 4032S 4PHR-9X 2PBP-8
```

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
