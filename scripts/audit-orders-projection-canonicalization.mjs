import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABS = ["new", "orders", "warehouse", "partial", "archived", "cancelled"];
const CLOSED = new Set(["FULFILLED", "CANCELLED", "REMOVED", "DENIED"]);
const WAREHOUSE = new Set(["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"]);
const NON_INVENTORY = /discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i;
const number = (value) => Number(value ?? 0);
const upper = (value) => String(value ?? "").trim().toUpperCase();

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
  return groups;
}

function isPhysical(line, manualMappingSkus) {
  const text = [line.legacy_item_code, line.products?.sku, line.products?.canonical_name].filter(Boolean).join(" ");
  return Boolean(line.product_id)
    && !manualMappingSkus.has(upper(line.products?.sku))
    && !manualMappingSkus.has(upper(line.legacy_item_code))
    && !NON_INVENTORY.test(text)
    && !["CANCELLED", "REMOVED", "DENIED"].includes(upper(line.fulfillment_status));
}

function lineQty(line) {
  return Math.max(number(line.ordered_qty), number(line.approved_qty));
}

function normalizeSku(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function qboSkuCandidates(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const candidates = [raw.toUpperCase()];
  if (/\(deleted/i.test(raw)) {
    let liveSku = raw.replace(/\s*\(deleted[^)]*\)\s*$/i, "").trim().toUpperCase();
    if (liveSku && !candidates.includes(liveSku)) candidates.push(liveSku);
    while (/[-\s]1$/.test(liveSku)) {
      liveSku = liveSku.replace(/[-\s]1$/, "").trim();
      if (liveSku && !candidates.includes(liveSku)) candidates.push(liveSku);
    }
  }
  return candidates;
}

function parseInvoiceItems(rawPayload) {
  const rawLines = Array.isArray(rawPayload?.Line) ? rawPayload.Line : [];
  return rawLines.map((row, index) => {
    if (!row || typeof row !== "object") return null;
    const sku = typeof row.SalesItemLineDetail?.ItemRef?.name === "string" ? row.SalesItemLineDetail.ItemRef.name.trim() : null;
    const description = typeof row.Description === "string" ? row.Description.trim() : "";
    const detailType = typeof row.DetailType === "string" ? row.DetailType : "";
    if (!sku && !description && detailType !== "SalesItemLineDetail") return null;
    const isNonInventory = detailType !== "SalesItemLineDetail" || description.startsWith("--") || String(sku ?? "").trim().toLowerCase() === "note" || String(sku ?? "").trim().toLowerCase().startsWith("note:") || NON_INVENTORY.test(`${sku ?? ""} ${description}`);
    const rawQty = row.SalesItemLineDetail?.Qty ?? row.Qty;
    const qty = Number(rawQty ?? Number.NaN);
    if (isNonInventory || (rawQty !== undefined && Number.isFinite(qty) && qty <= 0)) return null;
    return { key: String(row.Id ?? `${sku ?? "invoice-line"}-${index}`), sku, quantity: Number.isFinite(qty) && qty > 0 ? qty : 1 };
  }).filter(Boolean);
}

function matchesInvoiceSku(line, invoiceSku) {
  const invoiceKeys = qboSkuCandidates(invoiceSku).map(normalizeSku).filter(Boolean);
  const lineKeys = [line.legacy_item_code, line.products?.sku, line.products?.canonical_name].map(normalizeSku).filter(Boolean);
  return invoiceKeys.some((invoiceKey) => lineKeys.some((lineKey) => lineKey === invoiceKey || lineKey.includes(invoiceKey) || invoiceKey.includes(lineKey)));
}

function prioritizeLine(left, right) {
  const leftCompleted = upper(left.fulfillment_status) === "FULFILLED" ? 1 : 0;
  const rightCompleted = upper(right.fulfillment_status) === "FULFILLED" ? 1 : 0;
  if (leftCompleted !== rightCompleted) return rightCompleted - leftCompleted;
  const leftFulfilled = number(left.fulfilled_qty);
  const rightFulfilled = number(right.fulfilled_qty);
  if (leftFulfilled !== rightFulfilled) return rightFulfilled - leftFulfilled;
  const leftMapped = left.product_id ? 1 : 0;
  const rightMapped = right.product_id ? 1 : 0;
  if (leftMapped !== rightMapped) return rightMapped - leftMapped;
  const leftApproved = number(left.approved_qty);
  const rightApproved = number(right.approved_qty);
  if (leftApproved !== rightApproved) return rightApproved - leftApproved;
  return String(left.id).localeCompare(String(right.id));
}

function rawSummary(order, manualMappingSkus) {
  const lines = order.lines ?? [];
  const physical = lines.filter((line) => isPhysical(line, manualMappingSkus));
  const invoiceItems = parseInvoiceItems(order.qbo_invoices?.raw_payload);
  if (invoiceItems.length > 0) {
    const usedLineIds = new Set();
    const items = invoiceItems.map((item) => {
      const line = physical.filter((candidate) => !usedLineIds.has(candidate.id) && matchesInvoiceSku(candidate, item.sku)).sort(prioritizeLine)[0] ?? null;
      if (line?.id) usedLineIds.add(line.id);
      const fulfilled = Math.min(item.quantity, Math.max(0, number(line?.fulfilled_qty)));
      return { line, quantity: item.quantity, fulfilled };
    });
    const ordered = items.reduce((sum, item) => sum + item.quantity, 0);
    const fulfilled = items.reduce((sum, item) => sum + item.fulfilled, 0);
    return { ordered, fulfilled, remaining: Math.max(0, ordered - fulfilled), lineCount: items.length, items };
  }
  const ordered = physical.reduce((sum, line) => sum + lineQty(line), 0);
  const fulfilled = physical.reduce((sum, line) => sum + Math.min(lineQty(line), Math.max(0, number(line.fulfilled_qty))), 0);
  return { ordered, fulfilled, remaining: Math.max(0, ordered - fulfilled), lineCount: physical.length, items: physical.map((line) => ({ line, quantity: lineQty(line), fulfilled: Math.min(lineQty(line), Math.max(0, number(line.fulfilled_qty))) })) };
}

function classify(order, manualMappingSkus) {
  const lines = order.lines ?? [];
  const cancelled = upper(order.cancellation_status) === "CANCELLED";
  const voided = upper(order.qbo_invoices?.raw_payload?.PrivateNote) === "VOIDED";
  if (cancelled || voided) return ["cancelled"];
  if (order.duplicate_of_order_id) return [];
  const summary = rawSummary(order, manualMappingSkus);
  const operational = lines.filter((line) => isPhysical(line, manualMappingSkus) && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) && lineQty(line) > number(line.fulfilled_qty) && !CLOSED.has(upper(line.fulfillment_status)));
  const unresolved = lines.some((line) => !line.product_id && !NON_INVENTORY.test([line.legacy_item_code, line.products?.sku, line.products?.canonical_name].filter(Boolean).join(" ")) && !CLOSED.has(upper(line.fulfillment_status))) || (lines.length === 0 && order.source_type === "QBO_INVOICE");
  const visible = (summary.remaining > 0 && operational.length > 0) || (upper(order.review_status) !== "PENDING_REVIEW" && unresolved);
  const anyWarehouse = operational.some((line) => WAREHOUSE.has(upper(line.warehouse_status)));
  const anyShipped = summary.fulfilled > 0 || lines.some((line) => isPhysical(line, manualMappingSkus) && upper(line.fulfillment_status) === "PARTIALLY_FULFILLED");
  const tabs = [];
  if (visible) tabs.push("orders");
  if (visible && !anyWarehouse && !anyShipped) tabs.push("new");
  if (operational.length > 0 && anyWarehouse && !anyShipped) tabs.push("warehouse");
  if (anyShipped && summary.remaining > 0) tabs.push("partial");
  if ((summary.ordered > 0 && summary.remaining === 0) || (lines.length === 0 && upper(order.review_status) === "FULFILLED")) tabs.push("archived");
  return tabs;
}

function evidence(lines, fulfillmentsByLine, shipmentsByLine, allocationsByLine, transactionsByLine) {
  const lineIds = new Set(lines.map((line) => line.id));
  const fulfillmentRows = [...lineIds].flatMap((id) => fulfillmentsByLine.get(id) ?? []);
  const shipmentRows = [...lineIds].flatMap((id) => shipmentsByLine.get(id) ?? []);
  const allocationRows = [...lineIds].flatMap((id) => allocationsByLine.get(id) ?? []);
  const transactionRows = [...lineIds].flatMap((id) => transactionsByLine.get(id) ?? []);
  return {
    shipmentEvidence: { count: shipmentRows.length, quantity: shipmentRows.reduce((sum, row) => sum + number(row.quantity), 0), rows: shipmentRows.map((row) => ({ id: row.id, lineId: row.shipping_order_line_id, quantity: number(row.quantity) })) },
    fulfillmentEvidence: { count: fulfillmentRows.length, quantity: fulfillmentRows.reduce((sum, row) => sum + number(row.fulfilled_qty), 0), rows: fulfillmentRows.map((row) => ({ id: row.id, lineId: row.shipping_order_line_id, quantity: number(row.fulfilled_qty) })) },
    reservations: { count: allocationRows.filter((row) => row.allocation_status === "ALLOCATED").length, quantity: allocationRows.filter((row) => row.allocation_status === "ALLOCATED").reduce((sum, row) => sum + number(row.quantity), 0), rows: allocationRows.map((row) => ({ id: row.id, lineId: row.shipping_order_line_id, quantity: number(row.quantity), status: row.allocation_status, sourceType: row.source_type, containerId: row.container_id })) },
    inventoryTransactions: { count: transactionRows.length, buckets: Object.fromEntries(Object.entries(Object.groupBy(transactionRows, (row) => row.bucket)).map(([bucket, rows]) => [bucket, rows.reduce((sum, row) => sum + number(row.delta), 0)])), rows: transactionRows.map((row) => ({ id: row.id, lineId: row.shipping_order_line_id, bucket: row.bucket, delta: number(row.delta) })) },
  };
}

function parentDetail(order, manualMappingSkus, fulfillmentsByLine, shipmentsByLine, allocationsByLine, transactionsByLine) {
  const summary = rawSummary(order, manualMappingSkus);
  const orderEvidence = evidence(order.lines, fulfillmentsByLine, shipmentsByLine, allocationsByLine, transactionsByLine);
  return {
    id: order.id,
    sourceType: order.source_type,
    sourceSystem: order.source_system,
    orderedQty: summary.ordered,
    fulfilledQty: summary.fulfilled,
    remainingQty: summary.remaining,
    warehouseStatuses: [...new Set(order.lines.map((line) => line.warehouse_status).filter(Boolean))],
    products: summary.items.map(({ line, quantity, fulfilled }) => ({ productId: line?.product_id ?? null, sku: line?.products?.sku ?? null, quantity, fulfilled, remaining: Math.max(0, quantity - fulfilled), warehouseStatus: line?.warehouse_status ?? null })),
    queuePositions: order.lines.filter((line) => line.queue_position_start != null).map((line) => ({ lineId: line.id, start: number(line.queue_position_start), count: number(line.queue_position_count) })),
    ...orderEvidence,
    customerListDemand: summary.items.filter(({ line, quantity }) => line && ["APPROVED", "PARTIAL", "FULFILLED"].includes(upper(line.approval_status)) && upper(line.fulfillment_status) !== "CANCELLED").reduce((sum, { line, quantity }) => sum + Math.max(0, quantity - number(line.fulfilled_qty)), 0),
  };
}

const [orders, lines, fulfillments, shipmentLines, allocations, transactions, mappingRows] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,cancellation_status,review_status,created_at,legacy_customer_name,customers(company_name,full_name),qbo_invoices(invoice_number,raw_payload)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,qbo_invoice_line_id,approval_status,warehouse_status,fulfillment_status,ordered_qty,approved_qty,fulfilled_qty,legacy_item_code,source_system,queue_position_start,queue_position_count,products(sku,canonical_name)"),
  loadAll("fulfillments", "id,shipping_order_line_id,fulfilled_qty"),
  loadAll("order_shipment_lines", "id,shipping_order_line_id,quantity"),
  loadAll("inventory_allocations", "id,shipping_order_line_id,quantity,allocation_status,source_type,container_id"),
  loadAll("inventory_transactions", "id,shipping_order_line_id,bucket,delta"),
  loadAll("manual_product_mapping_queue", "source_sku"),
]);

const linesByOrder = groupBy(lines, "shipping_order_id");
const fulfillmentsByLine = groupBy(fulfillments, "shipping_order_line_id");
const shipmentsByLine = groupBy(shipmentLines, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const transactionsByLine = groupBy(transactions.filter((row) => row.shipping_order_line_id), "shipping_order_line_id");
const manualMappingSkus = new Set(mappingRows.map((row) => upper(row.source_sku)).filter(Boolean));
const directParentIds = new Set(lines.map((line) => line.shipping_order_id));
const relevantParents = orders.filter((order) => directParentIds.has(order.id) || order.source_type === "QBO_INVOICE").map((order) => ({ ...order, lines: linesByOrder.get(order.id) ?? [] }));
const activeBySource = groupBy(relevantParents.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id), "source_invoice_id");
const selectedBySource = new Map();
for (const [sourceInvoiceId, parents] of activeBySource) selectedBySource.set(sourceInvoiceId, [...parents].sort((left, right) => {
  const leftQbo = left.source_type === "QBO_INVOICE" ? 0 : 1;
  const rightQbo = right.source_type === "QBO_INVOICE" ? 0 : 1;
  return leftQbo - rightQbo || String(left.created_at).localeCompare(String(right.created_at));
})[0]);

const beforeRows = relevantParents.map((order) => ({ order, tabs: classify(order, manualMappingSkus) }));
const currentRows = relevantParents.filter((order) => !order.source_invoice_id || selectedBySource.get(order.source_invoice_id)?.id === order.id).map((order) => ({ order, tabs: classify(order, manualMappingSkus) }));
const beforeCounts = Object.fromEntries(TABS.map((tab) => [tab, beforeRows.filter((row) => row.tabs.includes(tab)).length]));
const currentCounts = Object.fromEntries(TABS.map((tab) => [tab, currentRows.filter((row) => row.tabs.includes(tab)).length]));
const disappeared = [];
for (const row of beforeRows) {
  const selected = row.order.source_invoice_id ? selectedBySource.get(row.order.source_invoice_id) : row.order;
  const currentTabs = selected?.id === row.order.id ? currentRows.find((current) => current.order.id === row.order.id)?.tabs ?? [] : currentRows.find((current) => current.order.id === selected?.id)?.tabs ?? [];
  const disappearedTabs = row.tabs.filter((tab) => !currentTabs.includes(tab));
  if (!disappearedTabs.length || !selected) continue;
  const parent = parentDetail(row.order, manualMappingSkus, fulfillmentsByLine, shipmentsByLine, allocationsByLine, transactionsByLine);
  const canonical = parentDetail(selected, manualMappingSkus, fulfillmentsByLine, shipmentsByLine, allocationsByLine, transactionsByLine);
  const hasIndependentEvidence = parent.remainingQty > 0 || parent.fulfilledQty > 0 || parent.shipmentEvidence.count > 0 || parent.fulfillmentEvidence.count > 0 || parent.reservations.quantity > 0 || parent.inventoryTransactions.count > 0;
  const hasUniqueProduct = parent.products.some((product) => !canonical.products.some((candidate) => candidate.productId === product.productId && candidate.fulfilled >= product.fulfilled && candidate.remaining >= product.remaining));
  const category = !hasIndependentEvidence ? "SAFE_DUPLICATE_COLLAPSE" : hasUniqueProduct ? "LEGITIMATE_DATA_LOST_FROM_PROJECTION" : currentTabs.length > 0 ? "MOVED_TO_OTHER_VALID_TAB" : "AMBIGUOUS_PARENT_SELECTION";
  disappeared.push({
    category,
    invoice: selected.qbo_invoices?.invoice_number ?? selected.order_number ?? row.order.order_number,
    customer: selected.customers?.company_name ?? selected.customers?.full_name ?? selected.legacy_customer_name ?? row.order.legacy_customer_name ?? null,
    previousTabs: row.tabs,
    currentTabs,
    disappearedTabs,
    sourceInvoiceId: row.order.source_invoice_id,
    rawParentIds: activeBySource.get(row.order.source_invoice_id ?? "")?.map((parentOrder) => parentOrder.id) ?? [row.order.id],
    canonicalParentId: selected.id,
    parent,
    canonical,
    reason: category === "LEGITIMATE_DATA_LOST_FROM_PROJECTION"
      ? "The excluded parent has product, quantity, or lifecycle evidence not represented by the selected parent."
      : category === "MOVED_TO_OTHER_VALID_TAB"
        ? "The selected parent remains visible, but lifecycle classification differs."
        : category === "SAFE_DUPLICATE_COLLAPSE"
          ? "The excluded parent has no operational quantity or linked evidence."
          : "The excluded parent has operational evidence, but comparison cannot prove whether it is duplicate or unique.",
  });
}

const reconciliation = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  baseline: "Pre-831ad22 raw-parent projection",
  current: "Current selected-parent projection",
  tabCounts: TABS.map((tab) => ({ tab, before: beforeCounts[tab], current: currentCounts[tab], difference: currentCounts[tab] - beforeCounts[tab], safeCollapses: disappeared.filter((row) => row.category === "SAFE_DUPLICATE_COLLAPSE" && row.disappearedTabs.includes(tab)).length, unexplained: disappeared.filter((row) => ["LEGITIMATE_DATA_LOST_FROM_PROJECTION", "AMBIGUOUS_PARENT_SELECTION"].includes(row.category) && row.disappearedTabs.includes(tab)).length })),
  summary: Object.fromEntries(["SAFE_DUPLICATE_COLLAPSE", "MOVED_TO_OTHER_VALID_TAB", "LEGITIMATE_DATA_LOST_FROM_PROJECTION", "AMBIGUOUS_PARENT_SELECTION"].map((category) => [category, disappeared.filter((row) => row.category === category).length])),
  disappeared,
};
fs.writeFileSync("tmp/import-reports/orders-projection-canonicalization-audit.json", JSON.stringify(reconciliation, null, 2));
console.log(JSON.stringify({ readOnly: true, tabCounts: reconciliation.tabCounts, summary: reconciliation.summary, report: "tmp/import-reports/orders-projection-canonicalization-audit.json" }, null, 2));