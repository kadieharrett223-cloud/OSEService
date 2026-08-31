# Protected Page Read Performance

## Purpose

The protected ERP pages are server-rendered against Supabase. Their read models retain the full
inventory, queue, fulfillment, and QBO-source semantics; page performance is improved by caching completed
read-only projections, never by omitting operational records or weakening calculations.

## Shared Read Models

- `loadCanonicalCustomerQueue()` is the authoritative Customer List projection used by Inventory and Order
  Detail. Its source reads and canonical projection are cached for 60 seconds with the
  `canonical-customer-queue` tag. The public loader reconstructs its lookup maps on every call, so callers
  retain the same queue, line, logical-demand, and product indexes.
- Inventory reuses the canonical Customer List projection for its open order lines, fulfillment evidence,
  reviewed resolutions, QBO sibling handling, and queue placement. Its separate 60-second base dataset is
  limited to the product catalog and aliases, inventory ledger totals, incoming containers, and display
  groups. A targeted QBO invoice-line lookup retains authoritative invoice quantities for displayed demand.
  Authentication, admin-mode access, URL filtering, and the final screen projection remain request-specific.
  This avoids a second cold full-table order reconciliation without changing Customer List, coverage, or
  physical-inventory semantics.
- The Orders list already uses the `orders-projection` cache for its complete logical-order projection.
  Invalidating that tag also expires the canonical Customer List and ERP Health diagnostic caches because
  those pages depend on the same operational order state.
- ERP Health caches its completed read-only consistency findings for 30 seconds with the `erp-health` tag.
  Filtering remains request-specific, while the expensive nested order/line/allocation checks and
  duplicate-parent scan are reused during routine navigation.

## Invalidation

Order, fulfillment, container, mapping, and QBO sync actions use `revalidateOrdersProjection()`, which
expires all three dependent read models immediately. Inventory administration, shipping review, queue, and
ERP Health actions explicitly expire the Inventory route and the queue and/or health cache when they mutate
those inputs. No cache
invalidation writes to Supabase or alters inventory transactions, demand, queue order, fulfillment, or QBO
intake behavior.

## Invoice Entry

`/orders/new` is the explicit, invoice-number entry point for manually admitting a QuickBooks invoice into
operations. Selecting either a missing invoice or an existing dormant representation runs the same guarded
refresh and activation path, then returns to the first page of the New Orders tab. New Orders sorts by the
order's operational `updated_at` timestamp, so an invoice entered through this workflow is shown first while
the displayed source order date remains unchanged. The action updates order/line operational state and queue
positions when mapping evidence permits; it never changes inventory quantities or bulk-activates invoices.

## Customer List Coverage

Customer List is the shared per-item view for all remaining physical ERP order lines. It includes a mapped
line regardless of source availability, allocation, warehouse state, parent review status, or reconciliation
health state. Lines are excluded only when they have no remaining quantity, are fulfilled/shipped/cancelled at
or replaced at the line level, or belong to a cancelled, voided, or duplicate order. Reviewed duplicate,
replacement, and historical fulfillment evidence also keep a stale re-imported line out of the list. Inventory,
order detail, and container coverage use the same read-only projection.

## Warehouse Recommendations

The `In Warehouse` Orders tab shows a read-only recommended packing batch before its existing warehouse work. It selects up to 10 complete New Orders
with remaining mapped physical lines, ordered by the oldest QuickBooks `qbo_invoices.invoice_date` first. When a record has no QuickBooks invoice date,
it falls back to `shipping_orders.created_at`. Selection uses
only current `ON_FLOOR` inventory and subtracts live floor allocations plus remaining quantities for active
warehouse, picked, and ready-to-ship work before considering a recommendation. Each recommended order must fit
in full; unmapped, partial, shipped, incoming-container-only, and already-warehouse orders are excluded. Moving
an order remains an explicit warehouse action and uses the existing guarded `moveOrderToWarehouseAction` path.