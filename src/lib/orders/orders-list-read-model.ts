import { unstable_cache } from "next/cache";
import { classifyOrder, matchesOrderTab } from "@/lib/orders/order-visibility";
import { getCanonicalPhysicalOrderSummary } from "@/lib/orders/physical-fulfillment";
import { cancellationAwareOperationalTotals } from "@/lib/orders/cancellation-presentation";
import { loadInventoryDisplayModel } from "@/lib/inventory/inventory-display-model";
import { orderWarehouseCoverage } from "@/lib/orders/order-warehouse-coverage";
import { buildLogicalOrdersProjection } from "@/lib/orders/logical-orders-projection";
import { ORDERS_PROJECTION_CACHE_TAG } from "@/lib/orders/orders-projection-cache";
import { INVENTORY_READ_MODEL_CACHE_TAG } from "@/lib/inventory/inventory-read-cache";
import { CANONICAL_CUSTOMER_QUEUE_CACHE_TAG } from "@/lib/demand/canonical-customer-queue-cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recommendWarehouseOrderIds } from "@/lib/orders/warehouse-recommendations";

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

export type ProjectedOrderRow = {
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
  quickbooksInvoiceDate: string | null;
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

async function getOrdersDatasetFromDatabase() {
    const supabase = getSupabaseAdmin();
    const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
    const ordersSelect = buildOrdersSelect(!duplicateParentColumnError);
    const { data: manualMappingRows } = await supabase
      .from("manual_product_mapping_queue")
      .select("source_sku")
      .eq("status", "OPEN");
    const manualMappingSkus = (manualMappingRows ?? []).map((row) => String((row as { source_sku?: string | null }).source_sku ?? "").trim().toUpperCase());

    const [directLines, qboParentRows, inventoryModel] = await Promise.all([
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
        legacy_matched_item_code,
        source_record_id,
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
      loadInventoryDisplayModel(),
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
    const { coverageByLineId, coverageByProduct, canonicalProductKeyById } = inventoryModel;
    const floorQuantityByProduct = new Map([...coverageByProduct].map(([key, coverage]) => [key, coverage.currentSupply]));
    const reservedQuantityByProduct = new Map([...coverageByProduct].map(([key, coverage]) => [key,
      coverage.demand.reduce((sum, line) => sum + Number(line.warehouse_reserved_qty ?? 0), 0),
    ]));
    const projectedOrders: ProjectedOrderRow[] = allOrders.map((order) => {
      const customerName = order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name ?? "Customer pending";
      const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
      const classification = classifyOrder(order, { manualMappingSkus: manualMappingSkuSet });
      const canonicalSummary = getCanonicalPhysicalOrderSummary({ rawPayload: order.qbo_invoices?.raw_payload, lines: order.shipping_order_lines, productIdBySku: inventoryModel.productIdBySku });
      const operationalTotals = cancellationAwareOperationalTotals(canonicalSummary, classification.isCancelled);
      const totalQty = operationalTotals.ordered;
      const hasPhysicalLines = canonicalSummary.lineCount > 0;
      const { inStockQty, stagedQty: warehouseQty, incomingQty, fullyWarehouseCovered } = orderWarehouseCoverage(canonicalSummary.items, coverageByLineId);
      const shippedQty = operationalTotals.fulfilled;
      const remainingQty = operationalTotals.remaining;
      const remainingInWarehouse = Math.min(remainingQty, Math.max(0, warehouseQty));
      const remainingAvailable = Math.min(Math.max(0, remainingQty - remainingInWarehouse), Math.max(0, inStockQty - warehouseQty));
      const remainingIncoming = Math.min(Math.max(0, remainingQty - remainingInWarehouse - remainingAvailable), incomingQty);
      const remainingWaiting = Math.max(0, remainingQty - remainingInWarehouse - remainingAvailable - remainingIncoming);
      const remainingStatusParts: string[] = [];
      if (remainingAvailable > 0) remainingStatusParts.push(`${remainingAvailable} available`);
      if (remainingInWarehouse > 0) remainingStatusParts.push(`${remainingInWarehouse} in warehouse`);
      if (remainingIncoming > 0) remainingStatusParts.push(`${remainingIncoming} incoming`);
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

      return { id: order.id, invoiceNumber, customerName, createdAt: order.created_at, quickbooksInvoiceDate: order.qbo_invoices?.invoice_date ?? null, updatedAt: order.updated_at, searchable, hasPhysicalLines, itemCount: canonicalSummary.lineCount, totalQty, shippedQty, remainingQty, remainingStatus, tabs, recommendedForWarehouse: classification.isNewOrder && fullyWarehouseCovered };
    });
    const eligibleIds = new Set(projectedOrders.filter((order) => order.recommendedForWarehouse).map((order) => order.id));
    const recommendedIds = new Set(recommendWarehouseOrderIds({
      candidates: allOrders.filter((order) => eligibleIds.has(order.id)).map((order) => ({
        id: order.id,
        createdAt: order.created_at,
        quickbooksInvoiceDate: order.qbo_invoices?.invoice_date,
        requirements: getCanonicalPhysicalOrderSummary({ rawPayload: order.qbo_invoices?.raw_payload, lines: order.shipping_order_lines, productIdBySku: inventoryModel.productIdBySku }).items
          .filter((item) => item.remaining > 0 && item.line?.product_id)
          .map((item) => ({ productId: canonicalProductKeyById.get(item.line!.product_id!) ?? item.line!.product_id!, quantity: item.remaining })),
      })),
      floorQuantityByProduct,
      reservedQuantityByProduct,
      limit: 10,
    }));
    for (const order of projectedOrders) order.recommendedForWarehouse = recommendedIds.has(order.id);
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

// The list page used to re-read every order line, allocation, and on-floor ledger event for
// every navigation. Cache only the derived read model briefly; actions already revalidate the
// orders route, and the source records remain the sole inventory and fulfillment authority.
export const getCachedOrdersDataset = unstable_cache(
  getOrdersDatasetFromDatabase,
  ["orders-list-read-model-v7-single-eta"],
  { revalidate: 300, tags: [ORDERS_PROJECTION_CACHE_TAG, INVENTORY_READ_MODEL_CACHE_TAG, CANONICAL_CUSTOMER_QUEUE_CACHE_TAG] },
);
