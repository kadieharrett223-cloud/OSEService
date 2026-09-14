import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { classifyOrder, matchesOrderTab } from "@/lib/orders/order-visibility";
import { getExactInvoiceSearchTab } from "@/lib/orders/orders-search";
import { getCanonicalPhysicalOrderSummary } from "@/lib/orders/physical-fulfillment";
import { cancellationAwareOperationalTotals } from "@/lib/orders/cancellation-presentation";
import { resolveProductCoverage, type LineCoverage, type OpenQueueLine } from "@/lib/fulfillment/suggested-allocation";
import { buildLogicalOrdersProjection } from "@/lib/orders/logical-orders-projection";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { OrdersBrowser } from "./orders-browser";

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
  source_invoice_id: string | null;
  duplicate_of_order_id?: string | null;
  cancellation_status?: string | null;
  notes: string | null;
  legacy_customer_name: string | null;
  review_status: string | null;
  created_at: string;
  updated_at: string;
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
    qbo_invoice_lines?: { qbo_line_id: string | null; qbo_sku: string | null } | null;
    source_system: string | null;
    legacy_item_code?: string | null;
    product_id?: string | null;
    fulfillment_source?: string | null;
    queue_position_start?: number | null;
    queue_position_override?: number | null;
    approved_at?: string | null;
    created_at?: string | null;
    products?: {
      sku: string | null;
      canonical_name: string | null;
    } | null;
    inventory_allocations?: Array<{
      quantity: number | null;
      source_type: string | null;
      allocation_status: string | null;
    }>;
  }>;
};

type ProjectedOrderRow = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  createdAt: string;
  updatedAt: string;
  searchable: string;
  hasPhysicalLines: boolean;
  itemCount: number;
  totalQty: number;
  shippedQty: number;
  remainingQty: number;
  remainingStatus: string;
  tabs: string[];
  recommendedForWarehouse: boolean;
};

function buildOrdersSelect(includeDuplicateField: boolean) {
  const orderFields = [
    "id",
    "order_number",
    "source_type",
    "source_invoice_id",
    "legacy_customer_name",
    "review_status",
    "cancellation_status",
    "created_at",
    "updated_at",
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

async function getOrdersDataset() {
    const supabase = getSupabaseAdmin();
    const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
    const ordersSelect = buildOrdersSelect(!duplicateParentColumnError);
    const { data: manualMappingRows } = await supabase
      .from("manual_product_mapping_queue")
      .select("source_sku")
      .eq("status", "OPEN");
    const manualMappingSkus = (manualMappingRows ?? []).map((row) => String((row as { source_sku?: string | null }).source_sku ?? "").trim().toUpperCase());

    const [directLines, qboParentRows, onFloorTransactions] = await Promise.all([
      fetchAllRows((from, to) => supabase
        .from("shipping_order_lines")
        .select(`
        id,
        shipping_order_id,
        product_id,
        qbo_invoice_line_id,
        qbo_invoice_lines (qbo_line_id, qbo_sku),
        approval_status,
        warehouse_status,
        fulfillment_status,
        priority,
        ordered_qty,
        approved_qty,
        fulfilled_qty,
        legacy_item_code,
        source_system,
        fulfillment_source,
        queue_position_start,
        queue_position_override,
        approved_at,
        created_at,
        products (sku, canonical_name),
        inventory_allocations (quantity, source_type, allocation_status)
      `)
        .order("id", { ascending: true })
        .range(from, to)),
      fetchAllRows((from, to) => supabase
        .from("shipping_orders")
        .select("id")
        .eq("source_type", "QBO_INVOICE")
        .order("created_at", { ascending: false })
        .range(from, to)),
      fetchAllRows((from, to) => supabase
        .from("inventory_transactions")
        .select("product_id, delta")
        .eq("bucket", "ON_FLOOR")
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

    const manualMappingSkuSet = new Set(manualMappingSkus);
    const directLinesByOrder = new Map<string, OrderSummary["shipping_order_lines"]>();
    for (const line of directLines as Array<{ shipping_order_id?: string; [key: string]: unknown }>) {
      if (!line.shipping_order_id) continue;
      directLinesByOrder.set(line.shipping_order_id, [
        ...(directLinesByOrder.get(line.shipping_order_id) ?? []),
        line as unknown as NonNullable<OrderSummary["shipping_order_lines"]>[number],
      ]);
    }
    const allOrders = buildLogicalOrdersProjection((orders as unknown as OrderSummary[]).map((order) => ({
      ...order,
      shipping_order_lines: directLinesByOrder.get(order.id) ?? order.shipping_order_lines ?? [],
    }))).sort((left, right) => {
      const leftCreated = Date.parse(left.created_at) || 0;
      const rightCreated = Date.parse(right.created_at) || 0;
      if (leftCreated !== rightCreated) return rightCreated - leftCreated;
      return right.id.localeCompare(left.id);
    });
    const floorQuantityByProduct = new Map<string, number>();
    for (const transaction of onFloorTransactions as Array<{ product_id: string | null; delta: number | null }>) {
      if (!transaction.product_id) continue;
      floorQuantityByProduct.set(transaction.product_id, (floorQuantityByProduct.get(transaction.product_id) ?? 0) + Number(transaction.delta ?? 0));
    }
    const allocationsByLineId = new Map<string, NonNullable<OrderSummary["shipping_order_lines"]>[number]["inventory_allocations"]>();
    for (const order of allOrders) {
      for (const line of order.shipping_order_lines ?? []) {
        allocationsByLineId.set(line.id, line.inventory_allocations);
      }
    }
    const queueLinesByProduct = new Map<string, OpenQueueLine[]>();
    for (const order of allOrders) {
      const classification = classifyOrder(order, { manualMappingSkus: manualMappingSkuSet });
      const canonicalSummary = getCanonicalPhysicalOrderSummary({ rawPayload: order.qbo_invoices?.raw_payload, lines: order.shipping_order_lines });
      for (const item of canonicalSummary.items) {
        const line = item.line;
        const productId = line?.product_id ?? null;
        const remaining = Math.max(0, item.quantity - Number(line?.fulfilled_qty ?? 0));
        if (remaining <= 0) continue;
        if (!productId || !line?.id || !classification.isVisibleOperationalOrder) continue;
        const floorReservedQty = (allocationsByLineId.get(line.id) ?? [])
          .filter((allocation) => String(allocation.allocation_status ?? "ALLOCATED").toUpperCase() !== "RELEASED" && String(allocation.source_type ?? "").toUpperCase() === "FLOOR")
          .reduce((sum, allocation) => sum + Math.max(0, Number(allocation.quantity ?? 0)), 0);
        const stagedQty = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()) ? remaining : 0;
        const queueLine: OpenQueueLine = {
          id: line.id,
          product_id: productId,
          remaining_qty: remaining,
          priority: line.priority ?? null,
          queue_position_start: line.queue_position_override ?? line.queue_position_start ?? null,
          approved_at: line.approved_at ?? null,
          created_at: line.created_at ?? order.created_at,
          has_live_allocation: (allocationsByLineId.get(line.id) ?? []).some((allocation) => String(allocation.allocation_status ?? "ALLOCATED").toUpperCase() !== "RELEASED"),
          fulfillment_source: line.fulfillment_source,
          warehouse_reserved_qty: Math.max(floorReservedQty, stagedQty),
        };
        queueLinesByProduct.set(productId, [...(queueLinesByProduct.get(productId) ?? []), queueLine]);
      }
    }
    const coverageByLineId = new Map<string, LineCoverage>();
    for (const productId of queueLinesByProduct.keys()) {
      const coverage = resolveProductCoverage(productId, {
        floorAvailableByProduct: floorQuantityByProduct,
        queueLinesByProduct,
        containerSupplyByProduct: new Map(),
      });
      for (const [lineId, lineCoverage] of coverage.lines) coverageByLineId.set(lineId, lineCoverage);
    }
    const projectedOrders: ProjectedOrderRow[] = allOrders.map((order) => {
      const customerName = order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name ?? "Customer pending";
      const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
      const classification = classifyOrder(order, { manualMappingSkus: manualMappingSkuSet });
      const canonicalSummary = getCanonicalPhysicalOrderSummary({ rawPayload: order.qbo_invoices?.raw_payload, lines: order.shipping_order_lines });
      const operationalTotals = cancellationAwareOperationalTotals(canonicalSummary, classification.isCancelled);
      const totalQty = operationalTotals.ordered;
      const hasPhysicalLines = canonicalSummary.lineCount > 0;
      const inStockQty = canonicalSummary.items.reduce((sum, { line }) => sum + (line?.id ? coverageByLineId.get(line.id)?.warehouseQty ?? 0 : 0), 0);
      const warehouseQty = canonicalSummary.items
        .filter(({ line }) => line && ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()))
        .reduce((sum, { line, quantity }) => sum + Math.max(0, quantity - Number(line?.fulfilled_qty ?? 0)), 0);
      const shippedQty = operationalTotals.fulfilled;
      const remainingQty = operationalTotals.remaining;
      const remainingInWarehouse = Math.min(remainingQty, Math.max(0, warehouseQty));
      const remainingAvailable = Math.min(Math.max(0, remainingQty - remainingInWarehouse), Math.max(0, inStockQty - warehouseQty));
      const remainingWaiting = Math.max(0, remainingQty - remainingInWarehouse - remainingAvailable);
      const remainingStatusParts: string[] = [];
      if (remainingAvailable > 0) remainingStatusParts.push(`${remainingAvailable} available`);
      if (remainingInWarehouse > 0) remainingStatusParts.push(`${remainingInWarehouse} in warehouse`);
      if (remainingWaiting > 0) remainingStatusParts.push(`${remainingWaiting} waiting`);
      const remainingStatus = classification.isCancelled ? "Cancelled" : remainingQty === 0 ? "Complete" : remainingStatusParts.length > 0 ? remainingStatusParts.join(" · ") : "Not in stock";
      const tabs = ["orders", "new", "warehouse", "partial", "archived", "cancelled"].filter((tab) => matchesOrderTab(classification, tab));
      const searchable = [
        order.order_number,
        order.legacy_customer_name,
        order.customers?.company_name,
        order.customers?.full_name,
        order.qbo_invoices?.invoice_number,
        ...(order.shipping_order_lines ?? []).flatMap((line) => [line.products?.sku, line.products?.canonical_name]),
      ].filter(Boolean).join(" ").toLowerCase();
      const fullyCoveredByWarehouse = remainingQty > 0 && canonicalSummary.items.every(({ line, remaining }) => remaining <= 0 || Boolean(line?.id && (coverageByLineId.get(line.id)?.warehouseQty ?? 0) >= remaining));
      return { id: order.id, invoiceNumber, customerName, createdAt: order.created_at, updatedAt: order.updated_at, searchable, hasPhysicalLines, itemCount: canonicalSummary.lineCount, totalQty, shippedQty, remainingQty, remainingStatus, tabs, recommendedForWarehouse: classification.isNewOrder && fullyCoveredByWarehouse };
    });
    const tabCounts = {
      orders: projectedOrders.filter((order) => order.tabs.includes("orders")).length,
      new: projectedOrders.filter((order) => order.tabs.includes("new")).length,
      warehouse: projectedOrders.filter((order) => order.tabs.includes("warehouse")).length,
      partial: projectedOrders.filter((order) => order.tabs.includes("partial")).length,
      archived: projectedOrders.filter((order) => order.tabs.includes("archived")).length,
      cancelled: projectedOrders.filter((order) => order.tabs.includes("cancelled")).length,
    };

  return { projectedOrders, tabCounts };
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; page?: string; message?: string; error?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const activeTab = params.tab ?? "new";
  const searchText = String(params.q ?? "").trim().toLowerCase();
  const currentPage = Math.max(1, Number.parseInt(String(params.page ?? "1"), 10) || 1);

  let projectedOrders: ProjectedOrderRow[] = [];
  let tabCounts = { orders: 0, new: 0, warehouse: 0, partial: 0, archived: 0, cancelled: 0 };
  let ordersLoadError: Error | null = null;
  try {
    const dataset = await getOrdersDataset();
    projectedOrders = dataset.projectedOrders;
    tabCounts = dataset.tabCounts;
  } catch (error) {
    ordersLoadError = error instanceof Error ? error : new Error("Unable to load Orders data");
  }

  const exactSearchTab = getExactInvoiceSearchTab(projectedOrders, searchText);
  if (exactSearchTab && exactSearchTab !== activeTab) {
    redirect(`/orders?${new URLSearchParams({ tab: exactSearchTab, q: searchText }).toString()}`);
  }

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
          <div className="flex flex-wrap gap-2">
            {activeTab === "warehouse" ? <Link href="/freight-consolidation" className="btn-primary inline-flex">Find Combined Shipments</Link> : null}
            <Link href="/orders/import-assign" className="btn-primary inline-flex">
              Import/Assign Review
            </Link>
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

      {params.message ? <div className="rounded-lg border border-[#b7e4c7] bg-[#ecfdf3] p-3 text-sm text-[#166534]">{params.message}</div> : null}
      {params.error ? <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</div> : null}
      {ordersLoadError ? <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load orders right now.</div> : null}
      <OrdersBrowser key={`${activeTab}:${searchText}`} rows={projectedOrders} tabCounts={tabCounts} initialTab={activeTab} initialPage={currentPage} searchText={searchText} />
    </div>
  );
}
