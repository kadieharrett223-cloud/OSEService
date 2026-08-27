import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const TARGET_INVOICES = new Set(["122285", "12584", "125957", "126070"]);
const CLOSED = new Set(["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
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

function rawQboItems(rawPayload) {
  return (Array.isArray(rawPayload?.Line) ? rawPayload.Line : []).map((row) => ({
    qboLineId: row?.Id ?? null,
    sku: row?.SalesItemLineDetail?.ItemRef?.name ?? null,
    description: row?.Description ?? null,
    quantity: number(row?.SalesItemLineDetail?.Qty ?? row?.Qty),
    detailType: row?.DetailType ?? null,
  })).filter((row) => row.detailType === "SalesItemLineDetail" && row.quantity > 0);
}

function isPhysicalQboItem(item) {
  return !/discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i.test(`${item.sku ?? ""} ${item.description ?? ""}`);
}

function qboSkuCandidates(value) {
  const raw = upper(value);
  if (!raw) return [];
  const candidates = [raw];
  if (/\(DELETED/.test(raw)) {
    let liveSku = raw.replace(/\s*\(DELETED[^)]*\)\s*$/, "").trim();
    candidates.push(liveSku);
    while (/[-\s]1$/.test(liveSku)) {
      liveSku = liveSku.replace(/[-\s]1$/, "").trim();
      candidates.push(liveSku);
    }
  }
  return [...new Set(candidates.map((candidate) => candidate.replace(/[^A-Z0-9]/g, "")).filter(Boolean))];
}

function sameSku(left, right) {
  const leftKeys = qboSkuCandidates(left);
  const rightKeys = qboSkuCandidates(right);
  return leftKeys.some((key) => rightKeys.includes(key));
}

function isOpen(line) {
  return Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty)) > 0
    && !CLOSED.has(upper(line.approval_status))
    && !CLOSED.has(upper(line.fulfillment_status));
}

const [orders, lines, qboLines, products, fulfillments, shipments, allocations] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,legacy_customer_name,customers(company_name,full_name),qbo_invoices(id,invoice_number,raw_payload)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,qbo_invoice_line_id,source_record_id,legacy_item_code,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status"),
  loadAll("qbo_invoice_lines", "id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id"),
  loadAll("products", "id,sku"),
  loadAll("fulfillments", "shipping_order_line_id,fulfilled_qty"),
  loadAll("order_shipment_lines", "shipping_order_line_id,quantity"),
  loadAll("inventory_allocations", "shipping_order_line_id,quantity,allocation_status"),
]);

const activeOrders = orders.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id);
const siblingsBySource = groupBy(activeOrders, "source_invoice_id");
const linesByOrder = groupBy(lines, "shipping_order_id");
const qboLinesByInvoice = groupBy(qboLines, "qbo_invoice_id");
const productsById = new Map(products.map((product) => [product.id, product]));
const fulfillmentsByLine = groupBy(fulfillments, "shipping_order_line_id");
const shipmentsByLine = groupBy(shipments, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const legacyIds = new Set(lines.filter((line) => line.source_record_id).map((line) => line.source_record_id));
const legacyRows = legacyIds.size ? await loadAll("old_erp_source_records", "source_record_id,source_container,raw_payload") : [];
const legacyById = new Map(legacyRows.map((row) => [row.source_record_id, row]));

const candidates = [];
for (const siblings of siblingsBySource.values()) {
  const qboParent = siblings.find((order) => order.source_type === "QBO_INVOICE" && TARGET_INVOICES.has(String(order.order_number)));
  const oldParent = siblings.find((order) => (order.source_system === "OLD_ERP" || order.source_type === "INTERNAL") && String(order.order_number) === String(qboParent?.order_number));
  if (!qboParent || !oldParent) continue;
  const qboSourceLines = qboLinesByInvoice.get(qboParent.source_invoice_id) ?? [];
  const qboParentLines = linesByOrder.get(qboParent.id) ?? [];
  const oldParentLines = linesByOrder.get(oldParent.id) ?? [];
  const projectedByIdentity = new Map();
  for (const line of [...qboParentLines, ...oldParentLines]) {
    const matchedQboLine = line.qbo_invoice_line_id
      ? qboSourceLines.find((candidate) => candidate.id === line.qbo_invoice_line_id)
      : qboSourceLines.filter((candidate) => candidate.product_id === line.product_id || sameSku(candidate.qbo_sku, line.legacy_item_code)).length === 1
        ? qboSourceLines.find((candidate) => candidate.product_id === line.product_id || sameSku(candidate.qbo_sku, line.legacy_item_code))
        : null;
    const identity = matchedQboLine ? `QBO_LINE:${matchedQboLine.id}` : line.source_record_id ? `SOURCE:${line.source_record_id}` : `LINE:${line.id}`;
    const current = projectedByIdentity.get(identity) ?? { identity, productId: line.product_id, sku: productsById.get(line.product_id)?.sku ?? line.legacy_item_code, qboLine: matchedQboLine ?? null, lines: [] };
    current.lines.push(line);
    projectedByIdentity.set(identity, current);
  }
  const projection = [...projectedByIdentity.values()].map((group) => {
    const provenFulfilled = Math.max(...group.lines.map((line) => Math.max(number(line.fulfilled_qty), (fulfillmentsByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.fulfilled_qty), 0))));
    const openRepresentations = group.lines.map((line) => ({ line, openQty: Math.max(0, number(line.approved_qty) - provenFulfilled) })).filter(({ line, openQty }) => openQty > 0 && isOpen({ ...line, fulfilled_qty: provenFulfilled }));
    const selected = openRepresentations.sort((left, right) => right.openQty - left.openQty || String(left.line.id).localeCompare(String(right.line.id)))[0] ?? null;
    return { identity: group.identity, sku: group.sku, qboSourceLine: group.qboLine ? { id: group.qboLine.id, qboLineId: group.qboLine.qbo_line_id, sku: group.qboLine.qbo_sku, description: group.qboLine.source_description, quantity: group.qboLine.ordered_qty, productId: group.qboLine.product_id } : null, projectedCustomerListAndCommittedQty: selected?.openQty ?? 0, selectedLineId: selected?.line.id ?? null, representations: group.lines.map((line) => ({ parent: line.shipping_order_id === qboParent.id ? "QBO" : "OLD_ERP", lineId: line.id, sourceRecordId: line.source_record_id, legacySourceFound: Boolean(line.source_record_id && legacyById.has(line.source_record_id)), productId: line.product_id, sku: productsById.get(line.product_id)?.sku ?? line.legacy_item_code, orderedQty: line.ordered_qty, approvedQty: line.approved_qty, fulfilledQty: line.fulfilled_qty, fulfillmentLedgerQty: (fulfillmentsByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.fulfilled_qty), 0), shipmentQty: (shipmentsByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.quantity), 0), activeAllocationQty: (allocationsByLine.get(line.id) ?? []).filter((row) => upper(row.allocation_status) === "ALLOCATED").reduce((sum, row) => sum + number(row.quantity), 0), warehouseStatus: line.warehouse_status })), };
  });
  const qboRawItems = rawQboItems(qboParent.qbo_invoices?.raw_payload);
  const qboCustomer = qboParent.customers?.company_name ?? qboParent.customers?.full_name ?? qboParent.legacy_customer_name ?? null;
  const oldCustomer = oldParent.customers?.company_name ?? oldParent.customers?.full_name ?? oldParent.legacy_customer_name ?? null;
  const sourceItemsCoverProjection = projection.every((item) => item.qboSourceLine && number(item.qboSourceLine.quantity) > 0);
  const disposition = sourceItemsCoverProjection ? "SAME_DEMAND_DIFFERENT_REPRESENTATION" : "UNRESOLVED";
  candidates.push({ invoice: qboParent.order_number, disposition, rationale: sourceItemsCoverProjection ? "Every canonical identity maps to one real QBO source line. OLD_ERP contributes the approved representation where QBO is pending review; the projection selects one identity rather than summing parents." : "At least one identity lacks a unique QBO source-line match.", customer: { qbo: qboCustomer, oldErp: oldCustomer, matches: upper(qboCustomer) === upper(oldCustomer) }, canonicalQboParentId: qboParent.id, oldErpParentId: oldParent.id, qboInvoice: { id: qboParent.source_invoice_id, rawItems: qboRawItems, sourceLines: qboSourceLines.map((line) => ({ id: line.id, qboLineId: line.qbo_line_id, sku: line.qbo_sku, description: line.source_description, quantity: line.ordered_qty, productId: line.product_id })) }, projection, totals: { customerListAndCommittedQty: projection.reduce((sum, item) => sum + item.projectedCustomerListAndCommittedQty, 0), qboSourcePhysicalQty: qboRawItems.filter(isPhysicalQboItem).reduce((sum, line) => sum + number(line.quantity), 0) } });
}

if (candidates.length !== TARGET_INVOICES.size) throw new Error(`Expected ${TARGET_INVOICES.size} candidates, found ${candidates.length}.`);
candidates.sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)));
const report = { generatedAt: new Date().toISOString(), readOnly: true, invariant: "Canonical Customer List and committed demand are deduplicated by QBO invoice-line identity where OLD_ERP has one unambiguous mapped QBO source line. This report performs no writes.", candidates };
fs.writeFileSync("tmp/import-reports/operational-parent-divergence-origin-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, candidates: candidates.map((candidate) => ({ invoice: candidate.invoice, disposition: candidate.disposition, canonicalCustomerListAndCommittedQty: candidate.totals.customerListAndCommittedQty, qboSourcePhysicalQty: candidate.totals.qboSourcePhysicalQty, rationale: candidate.rationale })), report: "tmp/import-reports/operational-parent-divergence-origin-audit.json" }, null, 2));