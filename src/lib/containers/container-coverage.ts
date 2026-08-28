import type { getSupabaseAdmin } from "@/lib/supabase/admin";
import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { dedupeDemandLines, isOpenDemandLine } from "@/lib/demand/product-demand";
import { resolveProductCoverage, type OpenQueueLine, type ProductContainerSupply } from "@/lib/fulfillment/suggested-allocation";
import { canonicalProductSkuKey, canonicalSkuKey } from "@/lib/products/canonical-sku";
import { computeCoverage, totalDemandQty, type CoverageRow, type DemandByProduct, type DemandLine } from "./coverage-math";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

const IN_WAREHOUSE_STATUSES = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED", "FULFILLED"];

export const UNPLANNED_RECEIPT_REF = "UNPLANNED_RECEIPT";

export type ContainerLineSummary = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  receivedQty: number;
  isUnplanned: boolean;
  demandQty: number;
  assignedQty: number;
  forecastCoverageQty: number;
};

export type ContainerForecastRow = DemandLine & {
  forecastSource: "WAREHOUSE" | "CONTAINER" | "UNASSIGNED";
  forecastSourceLabel: string;
  forecastQty: number;
  actuallyAssignedQty: number;
};

export type ContainerReceipt = {
  lifecycleStatus: string | null;
  isReceived: boolean;
  lines: ContainerLineSummary[];
  demandByProduct: DemandByProduct;
  /** Units used for coverage: actual received once the container is received, otherwise the forecast. */
  effectiveQtyByProduct: Record<string, number>;
  rows: CoverageRow[];
  forecastRows: ContainerForecastRow[];
  eligibleLineIds: Set<string>;
};

type ContainerLineRow = {
  id: string;
  product_id: string | null;
  ordered_qty: number | null;
  on_order_qty: number | null;
  received_qty: number | null;
  source_line_ref: string | null;
  products?: { sku: string | null; canonical_name: string | null } | null;
};

type OpenOrderLineRow = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  approval_status?: string | null;
  fulfillment_status?: string | null;
  qbo_invoice_line_id?: string | null;
  source_record_id?: string | null;
  parent_duplicate_of_order_id?: string | null;
  parent_cancellation_status?: string | null;
  parent_review_status?: string | null;
  parent_qbo_voided?: boolean;
  warehouse_status: string | null;
  queue_position_start: number | null;
  created_at: string;
  products?: { sku: string | null; canonical_name: string | null } | null;
  shipping_orders?: {
    id: string;
    order_number: string | null;
    legacy_customer_name: string | null;
    customers?: { company_name: string | null; full_name: string | null } | null;
    duplicate_of_order_id?: string | null;
    cancellation_status?: string | null;
    review_status?: string | null;
    qbo_invoices?: { invoice_number: string | null; raw_payload?: { PrivateNote?: string | null } | null } | null;
  } | null;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Planned quantities are a forecast; only received_qty reflects physical stock. */
export function getExpectedQty(line: { ordered_qty: number | null; on_order_qty: number | null }) {
  return Math.max(0, Number(line.ordered_qty ?? 0) || Number(line.on_order_qty ?? 0));
}

async function loadContainerForecast(supabase: SupabaseAdmin, containerId: string, containerLines: ContainerLineRow[]) {
  const [canonicalQueue, { data: products }, { data: aliases }] = await Promise.all([
    loadCanonicalCustomerQueue(),
    supabase.from("products").select("id,sku"),
    supabase.from("product_aliases").select("product_id,alias"),
  ]);
  const aliasesByProductId = new Map<string, string[]>();
  for (const alias of (aliases ?? []) as Array<{ product_id: string | null; alias: string | null }>) {
    if (!alias.product_id || !alias.alias) continue;
    aliasesByProductId.set(alias.product_id, [...(aliasesByProductId.get(alias.product_id) ?? []), alias.alias]);
  }
  const productKeyById = new Map((products ?? []).map((product) => [product.id, canonicalProductSkuKey(product.sku, aliasesByProductId.get(product.id))]));
  const containerKeys = new Set(containerLines.map((line) => productKeyById.get(line.product_id ?? "") ?? canonicalSkuKey(line.products?.sku)).filter(Boolean));
  const productIds = [...productKeyById.entries()].filter(([, key]) => containerKeys.has(key)).map(([id]) => id);
  if (!containerKeys.size || !productIds.length) return { rows: [] as ContainerForecastRow[], coverageByKey: new Map<string, ReturnType<typeof resolveProductCoverage>>() };

  const [{ data: floorRows }, { data: supplyRows }] = await Promise.all([
    supabase.from("inventory_transactions").select("product_id,delta").in("product_id", productIds).eq("bucket", "ON_FLOOR"),
    supabase.from("container_lines").select("product_id,container_id,on_order_qty,received_qty,containers(container_number,lifecycle_status,eta_confirmed_date,eta_estimated_date,entered_date)").in("product_id", productIds),
  ]);
  const floorByKey = new Map<string, number>();
  for (const row of (floorRows ?? []) as Array<{ product_id: string | null; delta: number | null }>) {
    const key = productKeyById.get(row.product_id ?? "");
    if (key) floorByKey.set(key, (floorByKey.get(key) ?? 0) + Number(row.delta ?? 0));
  }
  const supplyByKey = new Map<string, ProductContainerSupply[]>();
  const supplyIndex = new Map<string, ProductContainerSupply>();
  for (const row of (supplyRows ?? []) as Array<{ product_id: string | null; container_id: string | null; on_order_qty: number | null; received_qty: number | null; containers?: { container_number: string | null; lifecycle_status: string | null; eta_confirmed_date: string | null; eta_estimated_date: string | null; entered_date: string | null } | null }>) {
    const key = productKeyById.get(row.product_id ?? "");
    if (!key || !row.container_id || !["ORDERED", "PRODUCTION", "INBOUND"].includes(String(row.containers?.lifecycle_status ?? "").toUpperCase())) continue;
    const index = `${key}|${row.container_id}`;
    const qty = Math.max(0, Number(row.on_order_qty ?? 0) - Number(row.received_qty ?? 0));
    const existing = supplyIndex.get(index);
    if (existing) existing.available_qty = Math.max(existing.available_qty, qty);
    else supplyIndex.set(index, { container_id: row.container_id, container_number: row.containers?.container_number ?? null, available_qty: qty, eta_confirmed_date: row.containers?.eta_confirmed_date ?? null, eta_estimated_date: row.containers?.eta_estimated_date ?? null, entered_date: row.containers?.entered_date ?? null });
  }
  for (const [index, supply] of supplyIndex) {
    const [key] = index.split("|");
    supplyByKey.set(key, [...(supplyByKey.get(key) ?? []), supply]);
  }
  const canonicalLineById = new Map(canonicalQueue.canonicalLines.map((line) => [line.id, line]));
  const demandByKey = new Map<string, OpenQueueLine[]>();
  const metadata = new Map<string, Omit<ContainerForecastRow, "forecastSource" | "forecastSourceLabel" | "forecastQty">>();
  for (const [productId, queueRows] of canonicalQueue.queueByProductId) {
    const key = productKeyById.get(productId);
    if (!key || !containerKeys.has(key)) continue;
    for (const queueRow of queueRows) {
      const line = canonicalLineById.get(queueRow.lineId);
      if (!line) continue;
      const start = Number.parseInt(queueRow.position.split("-")[0] ?? "", 10);
      const actual = (line.inventory_allocations ?? []).filter((allocation) => allocation.allocation_status !== "RELEASED" && allocation.source_type === "CONTAINER" && allocation.container_id === containerId).reduce((sum, allocation) => sum + Math.max(0, Number(allocation.quantity ?? 0)), 0);
      demandByKey.set(key, [...(demandByKey.get(key) ?? []), { id: queueRow.lineId, product_id: key, remaining_qty: queueRow.openQty, priority: "NORMAL", queue_position_start: Number.isFinite(start) ? start : null, approved_at: null, created_at: queueRow.orderCreatedAt ?? new Date(0).toISOString(), has_live_allocation: actual > 0, fulfillment_source: line.fulfillment_source, warehouse_reserved_qty: 0 }]);
      metadata.set(queueRow.lineId, { lineId: queueRow.lineId, orderId: queueRow.orderId, productId, invoice: queueRow.invoice, customer: line.shipping_orders?.qbo_invoices?.customers?.company_name ?? line.shipping_orders?.qbo_invoices?.customers?.full_name ?? line.shipping_orders?.legacy_customer_name ?? "Customer pending", sku: line.products?.sku ?? "SKU pending", remainingQty: queueRow.openQty, queuePosition: Number.isFinite(start) ? start : null, currentWarehouse: formatStatus(line.warehouse_status), isAssigned: actual > 0, createdAt: queueRow.orderCreatedAt ?? new Date(0).toISOString(), actuallyAssignedQty: actual });
    }
  }
  const coverageByKey = new Map<string, ReturnType<typeof resolveProductCoverage>>();
  const rows: ContainerForecastRow[] = [];
  for (const key of containerKeys) {
    const coverage = resolveProductCoverage(key, { floorAvailableByProduct: new Map([[key, Math.max(0, floorByKey.get(key) ?? 0)]]), queueLinesByProduct: demandByKey, containerSupplyByProduct: supplyByKey });
    coverageByKey.set(key, coverage);
    for (const [lineId, lineCoverage] of coverage.lines) {
      const base = metadata.get(lineId);
      if (!base) continue;
      const currentContainer = lineCoverage.allocations.find((allocation) => allocation.sourceType === "CONTAINER" && allocation.sourceId === containerId);
      const source = currentContainer ?? lineCoverage.allocations[0];
      rows.push({ ...base, forecastSource: source?.sourceType ?? "UNASSIGNED", forecastSourceLabel: source?.sourceLabel ?? "Unassigned", forecastQty: currentContainer?.quantity ?? 0 });
    }
  }
  return { rows: rows.sort((left, right) => (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER)), coverageByKey };
}

export async function loadContainerReceipt(supabase: SupabaseAdmin, containerId: string): Promise<ContainerReceipt> {
  const [{ data: containerRow }, { data: containerLineRows }] = await Promise.all([
    supabase.from("containers").select("id, lifecycle_status").eq("id", containerId).maybeSingle(),
    supabase
      .from("container_lines")
      .select("id, product_id, ordered_qty, on_order_qty, received_qty, source_line_ref, products (sku, canonical_name)")
      .eq("container_id", containerId),
  ]);

  const lifecycleStatus = (containerRow as { lifecycle_status: string | null } | null)?.lifecycle_status ?? null;
  const isReceived = String(lifecycleStatus ?? "").toUpperCase() === "RECEIVED";
  const containerLines = ((containerLineRows ?? []) as unknown as ContainerLineRow[]).filter((line) => Boolean(line.product_id));
  const forecast = await loadContainerForecast(supabase, containerId, containerLines);

  const productIds = Array.from(new Set(containerLines.map((line) => line.product_id as string)));

  const [{ data: allocationRows }, { data: openLineRows }] = await Promise.all([
    supabase
      .from("inventory_allocations")
      .select("shipping_order_line_id")
      .eq("container_id", containerId)
      .eq("source_type", "CONTAINER")
      .eq("allocation_status", "ALLOCATED"),
    productIds.length
      ? supabase
          .from("shipping_order_lines")
          .select(`
            id,
            product_id,
            approved_qty,
            fulfilled_qty,
            approval_status,
            fulfillment_status,
            qbo_invoice_line_id,
            source_record_id,
            shipping_order_id,
            warehouse_status,
            queue_position_start,
            created_at,
            products (sku, canonical_name),
            shipping_orders (
              id,
              order_number,
              duplicate_of_order_id,
              cancellation_status,
              review_status,
              legacy_customer_name,
              customers (company_name, full_name),
              qbo_invoices (invoice_number, raw_payload)
            )
          `)
          .in("product_id", productIds)
          .eq("approval_status", "APPROVED")
          .neq("fulfillment_status", "FULFILLED")
      : Promise.resolve({ data: [] }),
  ]);

  const assignedLineIds = new Set(
    (allocationRows ?? [])
      .map((row) => (row as { shipping_order_line_id: string | null }).shipping_order_line_id)
      .filter((value): value is string => Boolean(value)),
  );

  const demandByProduct: DemandByProduct = {};
  for (const productId of productIds) demandByProduct[productId] = [];

  const activeOpenLines = ((openLineRows ?? []) as unknown as OpenOrderLineRow[]).map((line) => ({
    ...line,
    parent_duplicate_of_order_id: line.shipping_orders?.duplicate_of_order_id ?? null,
    parent_cancellation_status: line.shipping_orders?.cancellation_status ?? null,
    parent_review_status: line.shipping_orders?.review_status ?? null,
    parent_qbo_voided: String(line.shipping_orders?.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED",
  }));
  for (const line of dedupeDemandLines(activeOpenLines)) {
    if (!line.product_id || !demandByProduct[line.product_id]) continue;
    if (IN_WAREHOUSE_STATUSES.includes(line.warehouse_status ?? "")) continue;
    if (!isOpenDemandLine(line)) continue;

    const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    if (remainingQty <= 0) continue;

    const order = line.shipping_orders;
    demandByProduct[line.product_id].push({
      lineId: line.id,
      orderId: order?.id ?? "",
      productId: line.product_id,
      invoice: order?.qbo_invoices?.invoice_number ?? order?.order_number ?? "—",
      customer:
        order?.customers?.company_name ?? order?.customers?.full_name ?? order?.legacy_customer_name ?? "Customer pending",
      sku: line.products?.sku ?? line.products?.canonical_name ?? "SKU pending",
      remainingQty,
      queuePosition: line.queue_position_start ?? null,
      currentWarehouse: formatStatus(line.warehouse_status),
      isAssigned: assignedLineIds.has(line.id),
      createdAt: line.created_at,
    } satisfies DemandLine);
  }

  const effectiveQtyByProduct: Record<string, number> = {};
  const lines: ContainerLineSummary[] = containerLines.map((line) => {
    const productId = line.product_id as string;
    const productKey = canonicalSkuKey(line.products?.sku);
    const productForecast = forecast.coverageByKey.get(productKey);
    const expectedQty = getExpectedQty(line);
    const receivedQty = Math.max(0, Number(line.received_qty ?? 0));
    const demandQty = totalDemandQty(demandByProduct[productId] ?? []);
    const forecastCoverageQty = productForecast?.allocations
      .filter((allocation) => allocation.sourceType === "CONTAINER" && allocation.sourceId === containerId)
      .reduce((sum, allocation) => sum + allocation.quantity, 0) ?? 0;
    const assignedQty = forecast.rows
      .filter((row) => canonicalSkuKey(row.sku) === productKey)
      .reduce((sum, row) => sum + row.actuallyAssignedQty, 0);

    // Once received, physical counts are authoritative even when nothing arrived.
    const effectiveQty = isReceived ? receivedQty : expectedQty;
    effectiveQtyByProduct[productId] = (effectiveQtyByProduct[productId] ?? 0) + effectiveQty;

    return {
      id: line.id,
      productId,
      sku: line.products?.sku ?? "SKU pending",
      productName: line.products?.canonical_name ?? line.products?.sku ?? "Product",
      expectedQty,
      receivedQty,
      isUnplanned: line.source_line_ref === UNPLANNED_RECEIPT_REF,
      demandQty,
      assignedQty,
      forecastCoverageQty,
    };
  });

  const { rows, eligibleLineIds } = computeCoverage(demandByProduct, effectiveQtyByProduct);

  return { lifecycleStatus, isReceived, lines, demandByProduct, effectiveQtyByProduct, rows, forecastRows: forecast.rows, eligibleLineIds };
}
