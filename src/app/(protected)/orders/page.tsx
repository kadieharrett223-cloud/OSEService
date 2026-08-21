import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { classifyOrder, matchesOrderTab } from "@/lib/orders/order-visibility";
import { getCanonicalPhysicalOrderSummary } from "@/lib/orders/physical-fulfillment";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { unstable_cache } from "next/cache";
import { moveOrderToWarehouseAction } from "./actions";
import { OrdersTabLinks } from "./orders-tab-links";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const pageSize = 1000;
  const allRows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    allRows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  return allRows;
}

type OrderSummary = {
  id: string;
  order_number: string | null;
  source_type: string | null;
  duplicate_of_order_id?: string | null;
  cancellation_status?: string | null;
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
    raw_payload?: { PrivateNote?: string | null; Line?: unknown[] } | null;
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
    qbo_invoice_line_id?: string | null;
    source_system: string | null;
    legacy_item_code?: string | null;
    product_id?: string | null;
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

function buildOrdersSelect(includeDuplicateField: boolean) {
  const orderFields = [
    "id",
    "order_number",
    "source_type",
    "legacy_customer_name",
    "review_status",
    "cancellation_status",
    "created_at",
  ];
  if (includeDuplicateField) orderFields.splice(3, 0, "duplicate_of_order_id");
  return `
    ${orderFields.join(",\n      ")},
    customers (company_name, full_name),
    qbo_invoices (invoice_number, payment_status, invoice_date, raw_payload)
  `;
}

async function fetchRowsByIds<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const chunkSize = 100;
  const chunks = Array.from({ length: Math.ceil(ids.length / chunkSize) }, (_, index) => ids.slice(index * chunkSize, (index + 1) * chunkSize));
  const results = await Promise.all(chunks.map((chunk) => fetchChunk(chunk)));
  const rows: T[] = [];
  for (const result of results) {
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
  }
  return rows;
}

const getCachedOrdersDataset = unstable_cache(
  async () => {
    const supabase = getSupabaseAdmin();
    const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
    const ordersSelect = buildOrdersSelect(!duplicateParentColumnError);
    const { data: manualMappingRows } = await supabase
      .from("manual_product_mapping_queue")
      .select("source_sku")
      .eq("status", "OPEN");
    const manualMappingSkus = (manualMappingRows ?? []).map((row) => String((row as { source_sku?: string | null }).source_sku ?? "").trim().toUpperCase());

    const [directLines, qboParentRows] = await Promise.all([
      fetchAllRows((from, to) => supabase
        .from("shipping_order_lines")
        .select(`
        id,
        shipping_order_id,
        product_id,
        qbo_invoice_line_id,
        approval_status,
        warehouse_status,
        fulfillment_status,
        priority,
        ordered_qty,
        approved_qty,
        fulfilled_qty,
        legacy_item_code,
        source_system,
        products (sku, canonical_name)
      `)
        .order("id", { ascending: true })
        .range(from, to)),
      fetchAllRows((from, to) => supabase
        .from("shipping_orders")
        .select("id")
        .eq("source_type", "QBO_INVOICE")
        .order("created_at", { ascending: false })
        .range(from, to)),
    ]);
    const parentIds = [...new Set([
      ...(directLines as Array<{ shipping_order_id?: string }>).map((line) => line.shipping_order_id),
      ...(qboParentRows as Array<{ id?: string }>).map((order) => order.id),
    ].filter(Boolean))] as string[];
    const orders = await fetchRowsByIds(parentIds, (chunk) => supabase
      .from("shipping_orders")
      .select(ordersSelect)
      .in("id", chunk)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true }));

    return { orders, directLines, manualMappingSkus };
  },
  ["orders-page-dataset"],
  { revalidate: 10 },
);

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; message?: string; error?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const activeTab = params.tab ?? "new";
  const searchText = String(params.q ?? "").trim().toLowerCase();

  let orders: unknown[] = [];
  let directLines: unknown[] = [];
  let manualMappingSkus = new Set<string>();
  let ordersLoadError: Error | null = null;
  try {
    const dataset = await getCachedOrdersDataset();
    orders = dataset.orders;
    directLines = dataset.directLines;
    manualMappingSkus = new Set(dataset.manualMappingSkus);
  } catch (error) {
    ordersLoadError = error instanceof Error ? error : new Error("Unable to load Orders data");
  }

  const directLinesByOrder = new Map<string, OrderSummary["shipping_order_lines"]>();
  for (const line of directLines as Array<{ shipping_order_id?: string; [key: string]: unknown }>) {
    if (!line.shipping_order_id) continue;
    directLinesByOrder.set(line.shipping_order_id, [
      ...(directLinesByOrder.get(line.shipping_order_id) ?? []),
      line as unknown as NonNullable<OrderSummary["shipping_order_lines"]>[number],
    ]);
  }

  const allOrders = (orders as unknown as OrderSummary[]).map((order) => ({
    ...order,
    shipping_order_lines: directLinesByOrder.get(order.id) ?? order.shipping_order_lines ?? [],
  })).sort((left, right) => {
    const leftCreated = Date.parse(left.created_at) || 0;
    const rightCreated = Date.parse(right.created_at) || 0;
    if (leftCreated !== rightCreated) return rightCreated - leftCreated;
    return right.id.localeCompare(left.id);
  });

  function operationalLines(order: OrderSummary) {
    return classifyOrder(order, { manualMappingSkus }).operationalLines as OrderSummary["shipping_order_lines"];
  }
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
    return matchesOrderTab(classifyOrder(order, { manualMappingSkus }), tabId);
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
    cancelled: allOrders.filter((order) => matchesTab(order, "cancelled")).length,
  };

  const tabs = [
    { id: "new", label: "New Orders" },
    { id: "orders", label: "Orders" },
    { id: "warehouse", label: "In Warehouse" },
    { id: "partial", label: "Partially Shipped" },
    { id: "archived", label: "Archived" },
    { id: "cancelled", label: "Cancelled" },
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
          </div>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Total Orders", tabCounts.orders, "bg-[#eff6ff] text-[#2563eb]"],
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
        <OrdersTabLinks tabs={tabs.map((tab) => ({ ...tab, count: tabCounts[tab.id as keyof typeof tabCounts] ?? 0 }))} activeTab={activeTab} searchText={searchText} />
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

        {ordersLoadError ? (
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
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-[#f8fafc]">
                <tr className="border-b border-[#e5e7eb] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">
                  <th className="px-3 py-3">Order / Customer</th>
                  <th className="px-3 py-3">Ordered</th>
                  <th className="px-3 py-3">Shipped</th>
                  <th className="px-3 py-3">Remaining</th>
                  <th className="px-3 py-3">Remaining Status</th>
                  <th className="px-3 py-3">Order Date</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
            {orderSummaries.map((order) => {
              const customerName = order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name ?? "Customer pending";
              const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
              const canonicalSummary = getCanonicalPhysicalOrderSummary({ rawPayload: order.qbo_invoices?.raw_payload, lines: order.shipping_order_lines });
              const totalQty = canonicalSummary.ordered;
              const hasPhysicalLines = canonicalSummary.lineCount > 0;
              const inStockQty = canonicalSummary.items
                .filter(({ line }) => line && ["ON_FLOOR", "IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()))
                .reduce((sum, { line, quantity }) => sum + Math.max(0, Number(line?.fulfilled_qty ?? 0) >= quantity ? 0 : quantity - Number(line?.fulfilled_qty ?? 0)), 0);
              const warehouseQty = canonicalSummary.items
                .filter(({ line }) => line && ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()))
                .reduce((sum, { line, quantity }) => sum + Math.max(0, quantity - Number(line?.fulfilled_qty ?? 0)), 0);
              const shippedQty = canonicalSummary.fulfilled;
              const remainingQty = Math.max(0, totalQty - shippedQty);
              const remainingInWarehouse = Math.min(remainingQty, Math.max(0, warehouseQty));
              const remainingAvailable = Math.min(
                Math.max(0, remainingQty - remainingInWarehouse),
                Math.max(0, inStockQty - warehouseQty),
              );
              const remainingWaiting = Math.max(0, remainingQty - remainingInWarehouse - remainingAvailable);
              const remainingStatusParts: string[] = [];
              if (remainingAvailable > 0) remainingStatusParts.push(`${remainingAvailable} available`);
              if (remainingInWarehouse > 0) remainingStatusParts.push(`${remainingInWarehouse} in warehouse`);
              if (remainingWaiting > 0) remainingStatusParts.push(`${remainingWaiting} waiting`);
              const remainingStatus = remainingQty === 0
                ? "Complete"
                : remainingStatusParts.length > 0
                  ? remainingStatusParts.join(" · ")
                  : "Not in stock";
              return (
                <tr key={order.id} className="border-b border-[#f1f5f9] last:border-0 hover:bg-[#fafbfc]">
                  <td className="px-3 py-3">
                    <Link href={`/orders/${order.id}`} className="font-semibold text-[#1d4ed8] hover:underline">{invoiceNumber}</Link>
                    <div className="mt-1 text-xs text-[#64748b]">{customerName}</div>
                  </td>
                  <td className="px-3 py-3 font-semibold">{hasPhysicalLines ? `${canonicalSummary.lineCount} items · ${totalQty} units` : "Service / no inventory"}</td>
                  <td className="px-3 py-3 font-semibold text-[#0f766e]">{hasPhysicalLines ? `${shippedQty} of ${totalQty}` : "—"}</td>
                  <td className="px-3 py-3 font-semibold text-[#b45309]">{hasPhysicalLines ? remainingQty : "—"}</td>
                  <td className="px-3 py-3 font-semibold text-[#334155]">{hasPhysicalLines ? remainingStatus : "No physical fulfillment"}</td>
                  <td className="px-3 py-3 text-xs text-[#475569]">{formatDate(order.created_at)}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/orders/${order.id}`} className="btn-secondary inline-flex text-xs">View</Link>
                    {activeTab === "new" && hasPhysicalLines ? (
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
