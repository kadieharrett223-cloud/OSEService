import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type ProductRow = {
  id: string;
  sku: string | null;
  canonical_name: string | null;
  status: string | null;
};

type InventoryTransactionRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
};

type ContainerLineRow = {
  product_id: string | null;
  on_order_qty: number | null;
};

type ContainerRow = {
  id: string;
  lifecycle_status: string | null;
};

type WarehouseOrderLineRow = {
  shipping_order_id: string | null;
  warehouse_status: string | null;
  fulfillment_status: string | null;
};

type InvoiceLineRow = {
  product_id: string | null;
  qbo_invoice_id: string | null;
  qbo_invoices?: {
    invoice_number: string | null;
    payment_status: string | null;
  } | null;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value;
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

export default async function InventoryOverviewPage() {
  const supabase = await createClient();

  const [{ data: products }, { data: inventoryTransactions }, { data: containerLines }, { data: invoiceLines }, { data: containers }, { data: warehouseOrderLines }] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, canonical_name, status")
      .order("canonical_name", { ascending: true }),
    supabase
      .from("inventory_transactions")
      .select("product_id, bucket, delta"),
    supabase
      .from("container_lines")
      .select("product_id, on_order_qty"),
    supabase
      .from("qbo_invoice_lines")
      .select("product_id, qbo_invoice_id, qbo_invoices (invoice_number, payment_status)"),
    supabase
      .from("containers")
      .select("id, lifecycle_status"),
    supabase
      .from("shipping_order_lines")
      .select("shipping_order_id, warehouse_status, fulfillment_status"),
  ]);

  const productRows = (products ?? []) as ProductRow[];
  const transactionRows = (inventoryTransactions ?? []) as InventoryTransactionRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const invoiceLineRows = (invoiceLines ?? []) as InvoiceLineRow[];
  const containerRows = (containers ?? []) as ContainerRow[];
  const warehouseRows = (warehouseOrderLines ?? []) as WarehouseOrderLineRow[];

  const ledgerByProduct = new Map<string, { onFloor: number; incomingAvailable: number; sold: number; onOrderLedger: number }>();

  for (const row of transactionRows) {
    if (!row.product_id) continue;
    const existing = ledgerByProduct.get(row.product_id) ?? { onFloor: 0, incomingAvailable: 0, sold: 0, onOrderLedger: 0 };
    const value = Number(row.delta ?? 0);

    if (row.bucket === "ON_FLOOR") existing.onFloor += value;
    if (row.bucket === "INCOMING_AVAILABLE") existing.incomingAvailable += value;
    if (row.bucket === "SOLD") existing.sold += value;
    if (row.bucket === "ON_ORDER") existing.onOrderLedger += value;

    ledgerByProduct.set(row.product_id, existing);
  }

  const onOrderByProduct = new Map<string, number>();
  for (const row of containerLineRows) {
    if (!row.product_id) continue;
    const existing = onOrderByProduct.get(row.product_id) ?? 0;
    onOrderByProduct.set(row.product_id, existing + Number(row.on_order_qty ?? 0));
  }

  const invoicesByProduct = new Map<string, { invoiceCount: number; unpaidCount: number }>();
  for (const row of invoiceLineRows) {
    if (!row.product_id) continue;
    const existing = invoicesByProduct.get(row.product_id) ?? { invoiceCount: 0, unpaidCount: 0 };
    existing.invoiceCount += 1;
    if (row.qbo_invoices?.payment_status && row.qbo_invoices.payment_status !== "Paid") {
      existing.unpaidCount += 1;
    }
    invoicesByProduct.set(row.product_id, existing);
  }

  const inventoryRows = productRows.map((product) => {
    const ledger = ledgerByProduct.get(product.id) ?? { onFloor: 0, incomingAvailable: 0, sold: 0, onOrderLedger: 0 };
    const onOrderFromContainers = onOrderByProduct.get(product.id) ?? 0;
    const onOrder = onOrderFromContainers !== 0 ? onOrderFromContainers : ledger.onOrderLedger;
    const invoiceMeta = invoicesByProduct.get(product.id) ?? { invoiceCount: 0, unpaidCount: 0 };
    const totalPhysical = ledger.onFloor + ledger.incomingAvailable;

    return {
      ...product,
      onFloor: ledger.onFloor,
      incomingAvailable: ledger.incomingAvailable,
      onOrder,
      sold: ledger.sold,
      totalPhysical,
      invoiceCount: invoiceMeta.invoiceCount,
      unpaidInvoiceCount: invoiceMeta.unpaidCount,
    };
  });

  const totals = inventoryRows.reduce(
    (acc, row) => {
      acc.onFloor += row.onFloor;
      acc.incomingAvailable += row.incomingAvailable;
      acc.onOrder += row.onOrder;
      acc.totalPhysical += row.totalPhysical;
      return acc;
    },
    { onFloor: 0, incomingAvailable: 0, onOrder: 0, totalPhysical: 0 },
  );

  const containersOnOrderCount = containerRows.filter((container) => {
    const status = container.lifecycle_status ?? "";
    return status === "ORDERED" || status === "PRODUCTION" || status === "INBOUND";
  }).length;

  const inventoryAlertCount = inventoryRows.filter((row) => row.totalPhysical <= 0 && row.onOrder <= 0).length;

  const readyToShipOrderIds = new Set<string>();
  for (const row of warehouseRows) {
    if (!row.shipping_order_id) continue;
    if (row.fulfillment_status === "FULFILLED") continue;
    const status = row.warehouse_status ?? "";
    if (status === "IN_WAREHOUSE" || status === "PICKED" || status === "READY_TO_SHIP") {
      readyToShipOrderIds.add(row.shipping_order_id);
    }
  }
  const readyToShipCount = readyToShipOrderIds.size;

  const availableNow = totals.onFloor + totals.incomingAvailable;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Product Inventory</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              Full product inventory with on-floor, incoming, on-order, and invoice visibility.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/products" className="btn-secondary inline-flex">Manage Products</Link>
            <Link href="/orders" className="btn-secondary inline-flex">Open Orders</Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Containers on Order</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{containersOnOrderCount}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Inventory Alert</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{inventoryAlertCount}</p>
          <p className="mt-1 text-xs text-[#6b7280]">products with no stock and no on-order qty</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Ready to Ship</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{readyToShipCount}</p>
          <p className="mt-1 text-xs text-[#6b7280]">customer orders currently in warehouse flow</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Available Now</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{formatQuantity(availableNow)}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Full Product Inventory</h2>
          <p className="text-sm text-[#6b7280]">{inventoryRows.length} products</p>
        </div>

        {inventoryRows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No products are available yet.
          </div>
        ) : null}

        {inventoryRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-y-2">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.08em] text-[#6b7280]">
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">On Floor</th>
                  <th className="px-3 py-2">Incoming</th>
                  <th className="px-3 py-2">On Order</th>
                  <th className="px-3 py-2">Sold</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Invoices</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inventoryRows.map((row) => (
                  <tr key={row.id} className="rounded-xl bg-[#fafbfc] text-sm text-[#111827]">
                    <td className="rounded-l-xl border-y border-l border-[#e5e7eb] px-3 py-3 font-semibold">{row.canonical_name ?? "Unnamed product"}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">{row.sku ?? "—"}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">{formatStatus(row.status)}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">{formatQuantity(row.onFloor)}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">{formatQuantity(row.incomingAvailable)}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">{formatQuantity(row.onOrder)}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">{formatQuantity(row.sold)}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3 font-semibold">{formatQuantity(row.totalPhysical)}</td>
                    <td className="border-y border-[#e5e7eb] px-3 py-3">
                      <div className="flex flex-col">
                        <span>{row.invoiceCount} lines</span>
                        {row.unpaidInvoiceCount > 0 ? <span className="text-xs text-[#92400e]">{row.unpaidInvoiceCount} unpaid</span> : null}
                      </div>
                    </td>
                    <td className="rounded-r-xl border-y border-r border-[#e5e7eb] px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <Link href={`/products?edit=${row.id}`} className="btn-secondary inline-flex">Edit</Link>
                        <Link href={`/shipping-review?productId=${row.id}`} className="btn-secondary inline-flex">Show invoices</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
