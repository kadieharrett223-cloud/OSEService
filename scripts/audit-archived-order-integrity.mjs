import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CLOSED = new Set(["FULFILLED", "CANCELLED", "REMOVED", "DENIED"]);
const NON_INVENTORY = /discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i;
const upper = (value) => String(value ?? "").trim().toUpperCase();
const number = (value) => Number(value ?? 0);

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
  const grouped = new Map();
  for (const row of rows) grouped.set(row[key], [...(grouped.get(row[key]) ?? []), row]);
  return grouped;
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
    candidates.push(liveSku);
    while (/[-\s]1$/.test(liveSku)) {
      liveSku = liveSku.replace(/[-\s]1$/, "").trim();
      candidates.push(liveSku);
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

function isPhysical(line, manualMappingSkus) {
  const text = [line.legacy_item_code, line.products?.sku, line.products?.canonical_name].filter(Boolean).join(" ");
  return Boolean(line.product_id)
    && !manualMappingSkus.has(upper(line.products?.sku))
    && !manualMappingSkus.has(upper(line.legacy_item_code))
    && !NON_INVENTORY.test(text)
    && !["CANCELLED", "REMOVED", "DENIED"].includes(upper(line.fulfillment_status));
}

function physicalQuantity(line) {
  return Math.max(number(line.ordered_qty), number(line.approved_qty));
}

function parseInvoiceItems(rawPayload) {
  return (Array.isArray(rawPayload?.Line) ? rawPayload.Line : []).map((row, index) => {
    const sku = typeof row?.SalesItemLineDetail?.ItemRef?.name === "string" ? row.SalesItemLineDetail.ItemRef.name.trim() : null;
    const description = typeof row?.Description === "string" ? row.Description.trim() : "";
    const detailType = typeof row?.DetailType === "string" ? row.DetailType : "";
    const rawQuantity = row?.SalesItemLineDetail?.Qty ?? row?.Qty;
    const quantity = number(rawQuantity);
    const nonInventory = detailType !== "SalesItemLineDetail" || description.startsWith("--") || String(sku ?? "").toLowerCase() === "note" || NON_INVENTORY.test(`${sku ?? ""} ${description}`);
    if (nonInventory || (rawQuantity !== undefined && quantity <= 0)) return null;
    return { key: String(row?.Id ?? `${sku ?? "invoice-line"}-${index}`), sku, quantity: rawQuantity === undefined ? 1 : quantity };
  }).filter(Boolean);
}

function matchesInvoiceSku(line, invoiceSku) {
  const invoiceKeys = qboSkuCandidates(invoiceSku).map(normalizeSku);
  const lineKeys = [line.legacy_item_code, line.products?.sku, line.products?.canonical_name].map(normalizeSku).filter(Boolean);
  return invoiceKeys.some((invoiceKey) => lineKeys.some((lineKey) => lineKey === invoiceKey || lineKey.includes(invoiceKey) || invoiceKey.includes(lineKey)));
}

function prioritizeLine(left, right) {
  const completed = Number(upper(right.fulfillment_status) === "FULFILLED") - Number(upper(left.fulfillment_status) === "FULFILLED");
  if (completed) return completed;
  const fulfilled = number(right.fulfilled_qty) - number(left.fulfilled_qty);
  if (fulfilled) return fulfilled;
  return String(left.id).localeCompare(String(right.id));
}

function canonicalItems(order, manualMappingSkus) {
  const physicalLines = order.lines.filter((line) => isPhysical(line, manualMappingSkus));
  const invoiceItems = parseInvoiceItems(order.qbo_invoices?.raw_payload);
  if (!invoiceItems.length) return physicalLines.map((line) => ({ key: `LINE:${line.id}`, sku: line.products?.sku ?? line.legacy_item_code ?? null, ordered: physicalQuantity(line), line, candidates: [line] }));
  const usedLineIds = new Set();
  return invoiceItems.map((item) => {
    const candidates = physicalLines.filter((line) => matchesInvoiceSku(line, item.sku)).sort(prioritizeLine);
    const line = candidates.find((candidate) => !usedLineIds.has(candidate.id)) ?? null;
    if (line) usedLineIds.add(line.id);
    return { key: `QBO:${item.key}`, sku: item.sku, ordered: item.quantity, line, candidates };
  });
}

function activeAllocation(allocation) {
  return upper(allocation.allocation_status) !== "RELEASED";
}

const [orders, lines, fulfillments, shipmentLines, allocations, mappingRows] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_invoice_id,source_type,duplicate_of_order_id,cancellation_status,review_status,created_at,legacy_customer_name,customers(company_name,full_name),qbo_invoices(invoice_number,raw_payload)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,approval_status,warehouse_status,fulfillment_status,fulfillment_source,fulfillment_notes,ordered_qty,approved_qty,fulfilled_qty,legacy_item_code,queue_position_start,queue_position_count,products(sku,canonical_name)"),
  loadAll("fulfillments", "id,shipping_order_line_id,fulfilled_qty,fulfillment_type,reason,source_event_key"),
  loadAll("order_shipment_lines", "id,shipping_order_line_id,quantity"),
  loadAll("inventory_allocations", "id,shipping_order_line_id,container_id,quantity,allocation_status,source_type"),
  loadAll("manual_product_mapping_queue", "source_sku").catch((error) => { throw error; }),
]);

const linesByOrder = groupBy(lines, "shipping_order_id");
const fulfillmentsByLine = groupBy(fulfillments, "shipping_order_line_id");
const shipmentsByLine = groupBy(shipmentLines, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const manualMappingSkus = new Set(mappingRows.map((row) => upper(row.source_sku)).filter(Boolean));
const parents = orders.filter((order) => !order.duplicate_of_order_id && upper(order.cancellation_status) !== "CANCELLED" && upper(order.qbo_invoices?.raw_payload?.PrivateNote) !== "VOIDED").map((order) => ({ ...order, lines: linesByOrder.get(order.id) ?? [] }));
const parentsByInvoice = new Map();
for (const parent of parents) {
  const key = String(parent.source_invoice_id ?? parent.id).trim() || parent.id;
  parentsByInvoice.set(key, [...(parentsByInvoice.get(key) ?? []), parent]);
}

const results = [];
for (const siblings of parentsByInvoice.values()) {
  const canonicalParent = [...siblings].sort((left, right) => Number(right.source_type === "QBO_INVOICE") - Number(left.source_type === "QBO_INVOICE") || String(left.created_at).localeCompare(String(right.created_at)))[0];
  const order = { ...canonicalParent, lines: siblings.flatMap((parent) => parent.lines) };
  const items = canonicalItems(order, manualMappingSkus);
  const orderedUnits = items.reduce((sum, item) => sum + item.ordered, 0);
  const fulfilledUnits = items.reduce((sum, item) => sum + Math.max(0, number(item.line?.fulfilled_qty)), 0);
  const remainingUnits = items.reduce((sum, item) => sum + Math.max(0, item.ordered - number(item.line?.fulfilled_qty)), 0);
  const serviceOnly = order.lines.length === 0 && upper(order.review_status) === "FULFILLED";
  if (!serviceOnly && !(orderedUnits > 0 && remainingUnits === 0)) continue;

  const issues = [];
  const itemResults = items.map((item) => {
    const line = item.line;
    const ordered = item.ordered;
    const fulfilled = number(line?.fulfilled_qty);
    const shipped = (shipmentsByLine.get(line?.id) ?? []).reduce((sum, row) => sum + number(row.quantity), 0);
    const fulfillmentEvidence = (fulfillmentsByLine.get(line?.id) ?? []).reduce((sum, row) => sum + number(row.fulfilled_qty), 0);
    const activeAllocations = (allocationsByLine.get(line?.id) ?? []).filter(activeAllocation);
    const reserved = activeAllocations.filter((row) => !row.container_id).reduce((sum, row) => sum + number(row.quantity), 0);
    const containerAllocated = activeAllocations.filter((row) => row.container_id).reduce((sum, row) => sum + number(row.quantity), 0);
    const remaining = Math.max(0, ordered - fulfilled);
    const source = upper(line?.fulfillment_source) || "WAREHOUSE";
    const evidenceOnlyOther = source === "OTHER" && fulfillmentEvidence === fulfilled && fulfilled > 0 && shipped === 0 && Boolean(line?.fulfillment_notes);
    const itemIssues = [];
    if (!line) itemIssues.push("AMBIGUOUS_PARENT_EVIDENCE");
    if (fulfilled > ordered) itemIssues.push("ARCHIVED_FULFILLMENT_MISMATCH");
    if (remaining > 0) itemIssues.push("ARCHIVED_REMAINING_DEMAND");
    if (fulfillmentEvidence !== fulfilled) itemIssues.push("ARCHIVED_FULFILLMENT_MISMATCH");
    if (shipped !== fulfilled && !evidenceOnlyOther) itemIssues.push("ARCHIVED_SHIPMENT_MISMATCH");
    if (reserved > 0) itemIssues.push("ARCHIVED_RESERVATION_REMAINS");
    if (containerAllocated > 0) itemIssues.push("ARCHIVED_ALLOCATION_REMAINS");
    if (line && remaining > 0 && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) && !CLOSED.has(upper(line.fulfillment_status))) itemIssues.push("ARCHIVED_QUEUE_DEMAND_REMAINS");
    issues.push(...itemIssues);
    return { lineId: line?.id ?? null, sku: item.sku ?? line?.products?.sku ?? null, orderedQty: ordered, fulfilledQty: fulfilled, shipmentLineQty: shipped, fulfillmentEvidenceQty: fulfillmentEvidence, remainingQty: remaining, activeCustomerListQty: line && remaining > 0 && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) ? remaining : 0, warehouseReservedQty: reserved, activeContainerAllocatedQty: containerAllocated, source, otherEvidenceOnly: evidenceOnlyOther, issues: itemIssues };
  });
  const distinctIssues = [...new Set(issues)];
  results.push({ invoice: order.qbo_invoices?.invoice_number ?? order.order_number ?? order.source_invoice_id, customer: order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name ?? null, canonicalOrderId: order.id, siblingParentIds: siblings.map((parent) => parent.id), physicalItemCount: items.length, orderedUnits, fulfilledUnits, shipmentLineUnits: itemResults.reduce((sum, item) => sum + item.shipmentLineQty, 0), remainingUnits, activeCustomerListUnits: itemResults.reduce((sum, item) => sum + item.activeCustomerListQty, 0), warehouseReservedUnits: itemResults.reduce((sum, item) => sum + item.warehouseReservedQty, 0), activeContainerAllocatedUnits: itemResults.reduce((sum, item) => sum + item.activeContainerAllocatedQty, 0), lifecycleResult: distinctIssues.length ? distinctIssues : ["ARCHIVED_MATH_CLEAN"], items: itemResults });
}

const clean = results.filter((result) => result.lifecycleResult.length === 1 && result.lifecycleResult[0] === "ARCHIVED_MATH_CLEAN");
const warnings = results.filter((result) => result.items.some((item) => item.otherEvidenceOnly) && result.lifecycleResult[0] === "ARCHIVED_MATH_CLEAN");
const errors = results.filter((result) => !clean.includes(result));
const report = { generatedAt: new Date().toISOString(), readOnly: true, definition: "Archived logical orders are active same-invoice parents projected together. Canonical physical items exclude notes, discounts, freight, tax, installation, and service rows. No transaction balances are used.", summary: { totalArchivedOrders: results.length, clean: clean.length, errors: errors.length, warnings: warnings.length }, nonClean: errors, archivedOrders: results };
fs.writeFileSync("tmp/import-reports/archived-order-integrity-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, summary: report.summary, nonClean: report.nonClean.map((result) => ({ invoice: result.invoice, customer: result.customer, lifecycleResult: result.lifecycleResult, orderedUnits: result.orderedUnits, fulfilledUnits: result.fulfilledUnits, shipmentLineUnits: result.shipmentLineUnits, remainingUnits: result.remainingUnits, activeCustomerListUnits: result.activeCustomerListUnits, warehouseReservedUnits: result.warehouseReservedUnits, activeContainerAllocatedUnits: result.activeContainerAllocatedUnits })), report: "tmp/import-reports/archived-order-integrity-audit.json" }, null, 2));
if (errors.length > 0) process.exitCode = 1;