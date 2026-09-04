import { unstable_cache } from "next/cache";
import { projectCanonicalCustomerQueuesByProductKey, type ProjectedCustomerQueueRow } from "./canonical-customer-queue";
import { CANONICAL_CUSTOMER_QUEUE_CACHE_TAG } from "./canonical-customer-queue-cache";
import { demandLineIdentity, getCanonicalOpenDemandLines, isOpenDemandLine, withProvenFulfilledQty } from "./product-demand";
import type { ReviewedObligationResolution } from "./reviewed-obligation-resolutions";
import { getCanonicalPhysicalOrderSummary } from "@/lib/orders/physical-fulfillment";
import { qboSkuCandidates } from "@/lib/orders/quickbooks-refresh";
import { canonicalProductSkuKey } from "@/lib/products/canonical-sku";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type CanonicalQueueLine = {
  id: string; product_id: string | null; approved_qty: number | null; fulfilled_qty: number | null;
  canonical_obligation_qty?: number | null;
  approval_status: string | null; fulfillment_status: string | null; queue_position_start: number | null;
  queue_position_count: number | null; ordered_qty?: number | null; priority?: string | null; warehouse_status?: string | null; fulfillment_source?: string | null; legacy_item_code: string | null; qbo_invoice_line_id: string | null;
  source_record_id: string | null; logical_demand_key?: string | null;
  shipping_orders?: { id: string; source_invoice_id?: string | null; source_type?: string | null; order_number?: string | null;
    duplicate_of_order_id?: string | null; cancellation_status?: string | null; review_status?: string | null;
    created_at?: string | null; first_payment_at?: string | null; legacy_customer_name?: string | null; fulfillment_method?: "SHIP" | "WILL_CALL" | null;
    qbo_invoices?: { invoice_number?: string | null; invoice_date?: string | null; raw_payload?: { PrivateNote?: string | null; Line?: unknown[] } | null;
      customers?: { company_name?: string | null; full_name?: string | null } | null } | null } | null;
  products?: { sku?: string | null; canonical_name?: string | null } | null;
  inventory_allocations?: Array<{ source_type?: string | null; container_id?: string | null; quantity?: number | null; allocation_status?: string | null; containers?: { container_number?: string | null; lifecycle_status?: string | null; eta_confirmed_date?: string | null; eta_estimated_date?: string | null } | null }>;
};

export type CanonicalCustomerQueueLoaderResult = {
  queue: ProjectedCustomerQueueRow[];
  canonicalLines: CanonicalQueueLine[];
  qboInvoiceLines: CanonicalQboInvoiceLine[];
  manualMappingSkus: string[];
  queueByLineId: Map<string, ProjectedCustomerQueueRow>;
  queueByLogicalDemandKey: Map<string, ProjectedCustomerQueueRow>;
  queueByProductId: Map<string, ProjectedCustomerQueueRow[]>;
};

export type CanonicalQboInvoiceLine = {
  id: string;
  qbo_invoice_id: string;
  qbo_sku: string | null;
  product_id: string | null;
  ordered_qty: number | null;
};

type CachedCanonicalCustomerQueue = {
  queue: ProjectedCustomerQueueRow[];
  canonicalLines: CanonicalQueueLine[];
  qboInvoiceLines: CanonicalQboInvoiceLine[];
  manualMappingSkus: string[];
  lineProductIdEntries: Array<[string, string]>;
};

const normalizeSku = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const customerName = (line: CanonicalQueueLine) => line.shipping_orders?.qbo_invoices?.customers?.company_name
  ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
  ?? line.shipping_orders?.legacy_customer_name
  ?? "Customer pending";

async function fetchAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function fetchByIds<T>(ids: string[], fetch: (batch: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const batches = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
  return (await Promise.all(batches.map(async (batch) => {
    const { data, error } = await fetch(batch);
    if (error) throw new Error(error.message);
    return data ?? [];
  }))).flat();
}

/** Loads the exact canonical Customer List population used for display. This function is read-only. */
async function loadCanonicalCustomerQueueUncached(): Promise<CachedCanonicalCustomerQueue> {
  const supabase = getSupabaseAdmin();
  const [products, aliases, rawLines, fulfillmentRows, reviewedResolutions, mappingRows] = await Promise.all([
    fetchAll((from, to) => supabase.from("products").select("id,sku").range(from, to)),
    fetchAll((from, to) => supabase.from("product_aliases").select("product_id,alias").range(from, to)),
    fetchAll((from, to) => supabase.from("shipping_order_lines").select(`id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,fulfillment_source,priority,warehouse_status,queue_position_start,queue_position_count,legacy_item_code,qbo_invoice_line_id,source_record_id,shipping_orders(id,source_invoice_id,source_type,order_number,duplicate_of_order_id,cancellation_status,review_status,created_at,first_payment_at,legacy_customer_name,fulfillment_method,qbo_invoices(invoice_number,invoice_date,raw_payload,customers(company_name,full_name))),products(sku,canonical_name),inventory_allocations(source_type,container_id,quantity,allocation_status,containers(container_number,lifecycle_status,eta_confirmed_date,eta_estimated_date))`).neq("fulfillment_status", "CANCELLED").range(from, to)),
    fetchAll((from, to) => supabase.from("fulfillments").select("shipping_order_line_id,fulfilled_qty").range(from, to)),
    fetchAll((from, to) => supabase.from("reviewed_obligation_resolutions").select("source_record_id,qbo_invoice_line_id,resolution_type,status").eq("status", "ACTIVE").range(from, to)),
    supabase.from("manual_product_mapping_queue").select("source_sku").eq("status", "OPEN"),
  ]);

  const productIdByAlias = new Map<string, string>();
  const aliasesByProductId = new Map<string, string[]>();
  for (const product of products as Array<{ id: string; sku: string | null }>) if (product.sku) productIdByAlias.set(normalizeSku(product.sku), product.id);
  for (const alias of aliases as Array<{ product_id: string | null; alias: string | null }>) {
    if (!alias.product_id || !alias.alias) continue;
    productIdByAlias.set(normalizeSku(alias.alias), alias.product_id);
    aliasesByProductId.set(alias.product_id, [...(aliasesByProductId.get(alias.product_id) ?? []), alias.alias]);
  }
  const productQueueKeyById = new Map((products as Array<{ id: string; sku: string | null }>).map((product) => [product.id, canonicalProductSkuKey(product.sku, aliasesByProductId.get(product.id))]));
  const manualMappingSkus = new Set(((mappingRows.data ?? []) as unknown as Array<{ source_sku: string | null }>).map((row) => normalizeSku(row.source_sku)));

  const fulfilledByLineId = new Map<string, number>();
  for (const fulfillment of fulfillmentRows as Array<{ shipping_order_line_id: string; fulfilled_qty: number | null }>) fulfilledByLineId.set(fulfillment.shipping_order_line_id, (fulfilledByLineId.get(fulfillment.shipping_order_line_id) ?? 0) + Math.max(0, Number(fulfillment.fulfilled_qty ?? 0)));
  const queueLines = (rawLines as unknown as CanonicalQueueLine[]).map((line) => withProvenFulfilledQty(line, fulfilledByLineId.get(line.id) ?? 0));
  const sourceInvoiceIds = [...new Set(queueLines.map((line) => line.shipping_orders?.source_invoice_id).filter((value): value is string => Boolean(value)))];
  const orderNumbers = [...new Set(queueLines.map((line) => line.shipping_orders?.order_number).filter((value): value is string => Boolean(value)))];
  const [qboInvoices, qboLines, qboParents, sourceOrders] = await Promise.all([
    fetchByIds(sourceInvoiceIds, (ids) => supabase.from("qbo_invoices").select("id,raw_payload").in("id", ids)),
    fetchByIds(sourceInvoiceIds, (ids) => supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_sku,product_id,ordered_qty").in("qbo_invoice_id", ids)),
    fetchByIds(orderNumbers, (numbers) => supabase.from("shipping_orders").select("id,order_number,source_invoice_id,duplicate_of_order_id,cancellation_status,qbo_invoices(raw_payload,customers(company_name,full_name)),customers(company_name,full_name)").in("order_number", numbers).eq("source_type", "QBO_INVOICE")),
    fetchByIds(sourceInvoiceIds, (ids) => supabase.from("shipping_orders").select("source_invoice_id,review_status,duplicate_of_order_id,cancellation_status").in("source_invoice_id", ids)),
  ]);
  const payloadByInvoiceId = new Map((qboInvoices as Array<{ id: string; raw_payload: { PrivateNote?: string | null; Line?: unknown[] } | null }>).map((invoice) => [invoice.id, invoice.raw_payload]));
  const allQboLines = qboLines as CanonicalQboInvoiceLine[];
  const qboOrderedQtyByLineId = new Map(allQboLines.map((line) => [line.id, Math.max(0, Number(line.ordered_qty ?? 0))]));
  const activeQboParentsByNumber = new Map<string, Array<{ source_invoice_id: string | null; customers?: { company_name?: string | null; full_name?: string | null } | null; qbo_invoices?: { customers?: { company_name?: string | null; full_name?: string | null } | null } | null }>>();
  for (const parent of qboParents as unknown as Array<{ order_number: string | null; source_invoice_id: string | null; duplicate_of_order_id?: string | null; cancellation_status?: string | null; customers?: { company_name?: string | null; full_name?: string | null } | null; qbo_invoices?: { raw_payload?: { PrivateNote?: string | null } | null; customers?: { company_name?: string | null; full_name?: string | null } | null } | null }>) {
    if (parent.duplicate_of_order_id || String(parent.cancellation_status ?? "").toUpperCase() === "CANCELLED" || String(parent.qbo_invoices?.raw_payload?.PrivateNote ?? "").toUpperCase() === "VOIDED") continue;
    activeQboParentsByNumber.set(String(parent.order_number), [...(activeQboParentsByNumber.get(String(parent.order_number)) ?? []), parent]);
  }
  const bridged = queueLines.map((line) => {
    const sourceInvoiceId = line.shipping_orders?.source_invoice_id;
    const parent = line.shipping_orders;
    const parentFields = { parent_duplicate_of_order_id: parent?.duplicate_of_order_id ?? null, parent_cancellation_status: parent?.cancellation_status ?? null, parent_review_status: parent?.review_status ?? null, parent_qbo_voided: String(payloadByInvoiceId.get(sourceInvoiceId ?? "")?.PrivateNote ?? "").toUpperCase() === "VOIDED", parent_source_invoice_id: sourceInvoiceId ?? null, parent_source_type: parent?.source_type ?? null };
    if (line.qbo_invoice_line_id || !line.product_id) {
      const sourceQty = qboOrderedQtyByLineId.get(line.qbo_invoice_line_id ?? "") ?? 0;
      return { ...line, ...parentFields, ...(Number(line.approved_qty ?? 0) > 0 && sourceQty > 0 ? { canonical_obligation_qty: sourceQty } : {}) };
    }
    const qboParents = activeQboParentsByNumber.get(String(parent?.order_number ?? "")) ?? [];
    const qboParent = qboParents.find((candidate) => normalizeSku(candidate.customers?.company_name ?? candidate.customers?.full_name) === normalizeSku(customerName(line)));
    const bridgeInvoiceId = qboParent?.source_invoice_id ?? sourceInvoiceId;
    const candidates = allQboLines.filter((candidate) => candidate.qbo_invoice_id === bridgeInvoiceId && (candidate.product_id === line.product_id || qboSkuCandidates(candidate.qbo_sku).map(normalizeSku).some((key) => qboSkuCandidates(line.legacy_item_code).map(normalizeSku).includes(key))));
    const sourceQty = candidates.length === 1 ? qboOrderedQtyByLineId.get(candidates[0].id) ?? 0 : 0;
    return candidates.length === 1
      ? { ...line, ...parentFields, logical_demand_key: candidates[0].id, ...(Number(line.approved_qty ?? 0) > 0 && sourceQty > 0 ? { canonical_obligation_qty: sourceQty } : {}) }
      : { ...line, ...parentFields };
  });

  const completedInvoiceIds = new Set<string>();
  for (const order of sourceOrders as unknown as Array<{ source_invoice_id: string | null; review_status: string | null; duplicate_of_order_id?: string | null; cancellation_status?: string | null }>) if (order.source_invoice_id && (order.duplicate_of_order_id || String(order.cancellation_status ?? "").toUpperCase() === "CANCELLED" || ["ARCHIVED", "FULFILLED", "SHIPPED"].includes(String(order.review_status ?? "").toUpperCase()))) completedInvoiceIds.add(order.source_invoice_id);
  const completedLineIds = new Set<string>();
  const byOrderId = new Map<string, typeof bridged>();
  const byInvoiceId = new Map<string, typeof bridged>();
  for (const line of bridged) { if (line.shipping_orders?.id) byOrderId.set(line.shipping_orders.id, [...(byOrderId.get(line.shipping_orders.id) ?? []), line]); if (line.parent_source_invoice_id) byInvoiceId.set(line.parent_source_invoice_id, [...(byInvoiceId.get(line.parent_source_invoice_id) ?? []), line]); }
  const canonicalLineIds = new Map<string, Set<string> | null>();
  for (const [orderId, lines] of byOrderId) {
    const summary = getCanonicalPhysicalOrderSummary({ rawPayload: payloadByInvoiceId.get(lines[0]?.parent_source_invoice_id ?? ""), lines });
    canonicalLineIds.set(orderId, new Set(summary.items.map((item) => item.line?.id).filter((id): id is string => Boolean(id))));
    if (summary.isComplete) for (const item of summary.items) if (item.line?.qbo_invoice_line_id) completedLineIds.add(item.line.qbo_invoice_line_id);
  }
  for (const [invoiceId, lines] of byInvoiceId) {
    const summary = getCanonicalPhysicalOrderSummary({ rawPayload: payloadByInvoiceId.get(invoiceId), lines });
    if (summary.isComplete) completedInvoiceIds.add(invoiceId);
  }
  const canonicalLines = getCanonicalOpenDemandLines(bridged.filter((line) => {
    const ids = line.shipping_orders?.id ? canonicalLineIds.get(line.shipping_orders.id) : null;
    return !ids || ids.has(line.id);
  }), completedLineIds, completedInvoiceIds, reviewedResolutions as ReviewedObligationResolution[]);
  const queueRows: Array<ReturnType<typeof toCustomerQueueRow>> = [];
  const lineProductIdByLineId = new Map<string, string>();
  function toCustomerQueueRow(line: typeof canonicalLines[number]) {
    const parent = line.shipping_orders;
    const approvedQty = Math.max(0, Number(line.approved_qty ?? 0));
    const fulfilledQty = Math.max(0, Number(line.fulfilled_qty ?? 0));
    const firstPaymentAt = parent?.first_payment_at ?? null;
    const invoiceDate = parent?.qbo_invoices?.invoice_date ?? null;
    const priorityDate = firstPaymentAt;
    const priorityDateSource: "FIRST_PAYMENT" | "INVOICE_NUMBER" = firstPaymentAt ? "FIRST_PAYMENT" : "INVOICE_NUMBER";
    return { invoice: parent?.qbo_invoices?.invoice_number ?? parent?.order_number ?? "—", orderId: parent?.id ?? "", sourceInvoiceId: parent?.source_invoice_id ?? null, lineId: line.id, logicalDemandKey: demandLineIdentity(line), openQty: Math.max(0, approvedQty - fulfilledQty), warehouseQty: 0, waitingQty: Math.max(0, approvedQty - fulfilledQty), inWarehouse: false, willCall: false, qty: approvedQty, approvedQty, shippedQty: fulfilledQty, invoiceOrderedQty: null, provenInvoiceShippedQty: 0, invoiceFullyShipped: false, firstPaymentAt, invoiceDate, priorityDate, priorityDateSource, orderCreatedAt: parent?.created_at ?? null, storedPosition: line.queue_position_start, excludedFromQueue: manualMappingSkus.has(normalizeSku(line.products?.sku)) || manualMappingSkus.has(normalizeSku(line.legacy_item_code)) };
  }
  for (const line of canonicalLines) {
    if (!line.product_id || !isOpenDemandLine(line)) continue;
    queueRows.push(toCustomerQueueRow(line));
    lineProductIdByLineId.set(line.id, line.product_id);
  }
  const projected = projectCanonicalCustomerQueuesByProductKey(queueRows, (row) => (
    productQueueKeyById.get(lineProductIdByLineId.get(row.lineId) ?? "") || lineProductIdByLineId.get(row.lineId) || row.lineId
  ));
  const queueByLineId = new Map(projected.map((row) => [row.lineId, row]));
  const queueByLogicalDemandKey = new Map(projected.map((row) => [row.logicalDemandKey, row]));
  const queueByProductId = new Map<string, ProjectedCustomerQueueRow[]>();
  for (const row of projected) {
    const productId = lineProductIdByLineId.get(row.lineId);
    if (productId) queueByProductId.set(productId, [...(queueByProductId.get(productId) ?? []), row]);
  }
  return {
    queue: projected,
    canonicalLines,
    qboInvoiceLines: allQboLines,
    manualMappingSkus: [...manualMappingSkus],
    lineProductIdEntries: [...lineProductIdByLineId.entries()],
  };
}

const getCachedCanonicalCustomerQueue = unstable_cache(
  loadCanonicalCustomerQueueUncached,
  ["canonical-customer-queue"],
  { revalidate: 60, tags: [CANONICAL_CUSTOMER_QUEUE_CACHE_TAG] },
);

/** Loads the exact canonical Customer List population used for display. This function is read-only. */
export async function loadCanonicalCustomerQueue(): Promise<CanonicalCustomerQueueLoaderResult> {
  const { queue, canonicalLines, qboInvoiceLines, manualMappingSkus, lineProductIdEntries } = await getCachedCanonicalCustomerQueue();
  const lineProductIdByLineId = new Map(lineProductIdEntries);
  const queueByLineId = new Map(queue.map((row) => [row.lineId, row]));
  const queueByLogicalDemandKey = new Map(queue.map((row) => [row.logicalDemandKey, row]));
  const queueByProductId = new Map<string, ProjectedCustomerQueueRow[]>();
  for (const row of queue) {
    const productId = lineProductIdByLineId.get(row.lineId);
    if (productId) queueByProductId.set(productId, [...(queueByProductId.get(productId) ?? []), row]);
  }
  return { queue, canonicalLines, qboInvoiceLines, manualMappingSkus, queueByLineId, queueByLogicalDemandKey, queueByProductId };
}