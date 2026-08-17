import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { moveOrderToWarehouseAction } from "./actions";

type OrderSummary = {
  id: string;
  order_number: string | null;
  source_type: string | null;
  notes: string | null;
  legacy_customer_name: string | null;
  review_status: string | null;
  created_at: string;
  customers?: {
    company_name: string | null;
    full_name: string | null;
  } | null;
  qbo_invoices?: {
    invoice_number: string | null;
    payment_status: string | null;
    invoice_date: string | null;
  } | null;
  shipping_order_lines?: Array<{
    id: string;
    approval_status: string | null;
    warehouse_status: string | null;
    fulfillment_status: string | null;
    priority: string | null;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    source_system: string | null;
    products?: {
      sku: string | null;
      canonical_name: string | null;
    } | null;
  }>;
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function loadTableColumnSet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  tableName: string,
  candidates: string[],
) {
  const columns = new Set<string>();

  for (const column of candidates) {
    const { error } = await supabase.from(tableName).select(column).limit(1);
    if (!error) {
      columns.add(column);
    }
  }

  return columns;
}

function buildOrdersSelect(orderColumns: Set<string>, lineColumns: Set<string>) {
  const orderFields = [
    "id",
    "order_number",
    "source_type",
    "legacy_customer_name",
    "review_status",
    "created_at",
  ];
  if (orderColumns.has("notes")) {
    orderFields.push("notes");
  }

  const lineFields = [
    "id",
    "approval_status",
    "warehouse_status",
    "fulfillment_status",
    "priority",
    "ordered_qty",
    "approved_qty",
    "fulfilled_qty",
  ];
  if (lineColumns.has("source_system")) {
    lineFields.push("source_system");
  }

  return `
    ${orderFields.join(",\n      ")},
    customers (company_name, full_name),
    qbo_invoices (invoice_number, payment_status, invoice_date),
    shipping_order_lines (
      ${lineFields.join(",\n      ")},
      products (sku, canonical_name)
    )
  `;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; message?: string; error?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const params = await searchParams;
  const activeTab = params.tab ?? "new";
  const searchText = String(params.q ?? "").trim().toLowerCase();

  const [shippingOrderColumns, shippingOrderLineColumns] = await Promise.all([
    loadTableColumnSet(supabase, "shipping_orders", ["notes"]),
    loadTableColumnSet(supabase, "shipping_order_lines", ["source_system"]),
  ]);

  const ordersSelect = buildOrdersSelect(shippingOrderColumns, shippingOrderLineColumns);

  const { data: orders, error } = await supabase
    .from("shipping_orders")
    .select(ordersSelect)
    .order("created_at", { ascending: false });

  const allOrders = (orders ?? []) as unknown as OrderSummary[];
  const liveOrderIdByInvoice = new Map<string, string>();
  for (const order of allOrders) {
    const invoice = order.qbo_invoices?.invoice_number ?? order.order_number;
    if (invoice) liveOrderIdByInvoice.set(invoice.toUpperCase(), order.id);
  }

  const deniedCustomerByInvoice = new Map<string, string>();
  for (const order of allOrders) {
    const customerName = order.customers?.company_name
      ?? order.customers?.full_name
      ?? order.legacy_customer_name
      ?? null;

    if (!customerName) continue;

    const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? null;
    if (!invoiceNumber) continue;

    deniedCustomerByInvoice.set(invoiceNumber.toUpperCase(), customerName);
  }

  function matchesTab(order: OrderSummary, tabId: string) {
    const lines = order.shipping_order_lines ?? [];
    const hasLines = lines.length > 0;
    const allFulfilled = hasLines && lines.every((line) => line.fulfillment_status === "FULFILLED");
    const anyWarehouse = lines.some((line) => line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "PICKED" || line.warehouse_status === "READY_TO_SHIP");
    const anyShipped = lines.some((line) => Number(line.fulfilled_qty ?? 0) > 0 || line.fulfillment_status === "PARTIALLY_FULFILLED");
    const anyOpen = lines.some((line) => line.fulfillment_status !== "FULFILLED" && line.fulfillment_status !== "CANCELLED");

    switch (tabId) {
      case "orders":
        return true;
      case "new":
        return anyOpen && !anyWarehouse && !anyShipped && !allFulfilled;
      case "warehouse":
        return anyWarehouse && !anyShipped && !allFulfilled;
      case "partial":
        return anyShipped && !allFulfilled;
      case "archived":
        return allFulfilled || order.review_status === "FULFILLED";
      default:
        return true;
    }
  }

  const orderSummaries = allOrders.filter((order) => {
    if (!matchesTab(order, activeTab)) return false;
    if (!searchText) return true;

    const searchable = [
      order.order_number,
      order.legacy_customer_name,
      order.customers?.company_name,
      order.customers?.full_name,
      order.qbo_invoices?.invoice_number,
      ...(order.shipping_order_lines ?? []).flatMap((line) => [line.products?.sku, line.products?.canonical_name]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchable.includes(searchText);
  });

  const tabCounts = {
    orders: allOrders.filter((order) => matchesTab(order, "orders")).length,
    new: allOrders.filter((order) => matchesTab(order, "new")).length,
    warehouse: allOrders.filter((order) => matchesTab(order, "warehouse")).length,
    partial: allOrders.filter((order) => matchesTab(order, "partial")).length,
    archived: allOrders.filter((order) => matchesTab(order, "archived")).length,
  };

  const tabs = [
    { id: "new", label: "New Orders" },
    { id: "orders", label: "Orders" },
    { id: "warehouse", label: "In Warehouse" },
    { id: "partial", label: "Partially Shipped" },
    { id: "archived", label: "Archived" },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Orders & Shipping</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Orders</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              Shipping operations for review, assignment, warehouse execution, shipment, and final fulfillment.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/orders/new" className="btn-primary inline-flex">Enter QuickBooks Order</Link>
            <Link href="/schedule" className="btn-secondary inline-flex">Open Schedule</Link>
          </div>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Total Orders", allOrders.length, "bg-[#eff6ff] text-[#2563eb]"],
          ["New Orders", tabCounts.new, "bg-[#ecfdf5] text-[#15803d]"],
          ["In Warehouse", tabCounts.warehouse, "bg-[#fff7ed] text-[#c2410c]"],
          ["Partially Shipped", tabCounts.partial, "bg-[#fff7ed] text-[#c2410c]"],
          ["Archived", tabCounts.archived, "bg-[#eff6ff] text-[#1d4ed8]"],
        ].map(([label, value, color]) => (
          <div key={String(label)} className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
            <div className={`inline-flex rounded-lg px-2 py-1 text-xs font-bold ${color}`}>{label}</div>
            <p className="mt-2 text-2xl font-bold text-[#111827]">{value}</p>
          </div>
        ))}
      </section>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form method="GET" className="mb-4 flex flex-wrap gap-2">
          <input type="hidden" name="tab" value={activeTab} />
          <input
            name="q"
            defaultValue={searchText}
            placeholder="Filter by item number, invoice, or customer"
            className="input min-w-[280px] flex-1"
          />
          <button type="submit" className="btn-secondary">Filter</button>
          <Link href={`/orders?tab=${activeTab}`} className="btn-ghost">Clear</Link>
        </form>
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <Link
                key={tab.id}
                href={searchText ? `/orders?tab=${tab.id}&q=${encodeURIComponent(searchText)}` : `/orders?tab=${tab.id}`}
                className={`rounded-full px-3 py-2 text-sm font-semibold ${isActive ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151]"}`}
              >
                {tab.label} ({tabCounts[tab.id as keyof typeof tabCounts] ?? 0})
              </Link>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {params.message ? (
          <div className="mb-4 rounded-lg border border-[#b7e4c7] bg-[#ecfdf3] p-3 text-sm text-[#166534]">
            {params.message}
          </div>
        ) : null}

        {params.error ? (
          <div className="mb-4 rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
            {params.error}
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
            Unable to load orders right now.
          </div>
        ) : null}

        {orderSummaries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            <p>{searchText ? "No orders match that filter in this status." : "No orders match this status yet."}</p>
          </div>
        ) : null}

        {orderSummaries.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-[#e5e7eb]">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="bg-[#f8fafc]">
                <tr className="border-b border-[#e5e7eb] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">
                  <th className="px-3 py-3">Order / Customer</th>
                  <th className="px-3 py-3">Ordered</th>
                  <th className="px-3 py-3">In Stock</th>
                  <th className="px-3 py-3">In Warehouse</th>
                  <th className="px-3 py-3">Shipped</th>
                  <th className="px-3 py-3">Remaining</th>
                  <th className="px-3 py-3">Order Date</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
            {orderSummaries.map((order) => {
              const customerName = order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name ?? "Customer pending";
              const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
              const lines = order.shipping_order_lines ?? [];
              const totalQty = lines.reduce((sum, line) => sum + Number(line.ordered_qty ?? 0), 0);
              const inStockQty = lines
                .filter((line) => ["ON_FLOOR", "IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()))
                .reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);
              const warehouseQty = lines
                .filter((line) => ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()))
                .reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);
              const shippedQty = lines.reduce((sum, line) => sum + Number(line.fulfilled_qty ?? 0), 0);
              const remainingQty = Math.max(0, totalQty - shippedQty);
              return (
                <tr key={order.id} className="border-b border-[#f1f5f9] last:border-0 hover:bg-[#fafbfc]">
                  <td className="px-3 py-3">
                    <Link href={`/orders/${order.id}`} className="font-semibold text-[#1d4ed8] hover:underline">{invoiceNumber}</Link>
                    <div className="mt-1 text-xs text-[#64748b]">{customerName}</div>
                  </td>
                  <td className="px-3 py-3 font-semibold">{lines.length} items · {totalQty} units</td>
                  <td className="px-3 py-3 font-semibold text-[#15803d]">{inStockQty} / {totalQty}</td>
                  <td className="px-3 py-3 font-semibold text-[#c2410c]">{warehouseQty} / {totalQty}</td>
                  <td className="px-3 py-3">
                    <span className="font-semibold text-[#0f766e]">{shippedQty} / {totalQty}</span>
                    {shippedQty > 0 && remainingQty > 0 ? (
                      <div className="mt-1 text-xs font-semibold text-[#b45309]">{remainingQty} remaining</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 font-semibold text-[#b45309]">{remainingQty}</td>
                  <td className="px-3 py-3 text-xs text-[#475569]">{formatDate(order.created_at)}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/orders/${order.id}`} className="btn-secondary inline-flex text-xs">View</Link>
                    {activeTab === "new" ? (
                      <form action={moveOrderToWarehouseAction}>
                        <input type="hidden" name="orderId" value={order.id} />
                        <button type="submit" className="btn-primary inline-flex text-xs">Move to Warehouse</button>
                      </form>
                    ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
              </tbody>
            </table>
          </div>
        ) : null}

      </div>
    </div>
  );
}
