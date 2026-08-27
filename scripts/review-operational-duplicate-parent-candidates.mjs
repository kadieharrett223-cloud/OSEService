import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const TARGET_INVOICES = new Set(["122285", "12584", "125957", "126070"]);

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

function summarize(lines, productsById, fulfillmentsByLine, shipmentLinesByLine, allocationsByLine, transactionsByLine) {
  return lines.map((line) => {
    const ordered = Math.max(number(line.ordered_qty), number(line.approved_qty));
    const approved = number(line.approved_qty);
    const fulfilled = number(line.fulfilled_qty);
    const fulfillments = fulfillmentsByLine.get(line.id) ?? [];
    const shipments = shipmentLinesByLine.get(line.id) ?? [];
    const allocations = allocationsByLine.get(line.id) ?? [];
    const transactions = transactionsByLine.get(line.id) ?? [];
    return {
      lineId: line.id,
      productId: line.product_id,
      sku: productsById.get(line.product_id)?.sku ?? line.legacy_item_code ?? null,
      orderedQty: ordered,
      approvedQty: approved,
      fulfilledQty: fulfilled,
      remainingDemand: Math.max(0, approved - fulfilled),
      approvalStatus: line.approval_status,
      fulfillmentStatus: line.fulfillment_status,
      warehouseStatus: line.warehouse_status,
      fulfillmentLedgerQty: fulfillments.reduce((sum, row) => sum + number(row.fulfilled_qty), 0),
      shipmentQty: shipments.reduce((sum, row) => sum + number(row.quantity), 0),
      activeAllocationQty: allocations.filter((row) => upper(row.allocation_status) === "ALLOCATED").reduce((sum, row) => sum + number(row.quantity), 0),
      inventoryTransactionCount: transactions.length,
    };
  }).sort((left, right) => String(left.sku).localeCompare(String(right.sku)) || left.lineId.localeCompare(right.lineId));
}

function matchingObligation(qboLines, oldLines) {
  if (qboLines.length !== oldLines.length) return false;
  const qboByProduct = new Map(qboLines.map((line) => [line.productId, line]));
  return oldLines.every((line) => {
    const qbo = qboByProduct.get(line.productId);
    return qbo && qbo.orderedQty === line.orderedQty && qbo.approvedQty === line.approvedQty;
  });
}

const [orders, lines, products, fulfillments, shipmentLines, allocations, transactions] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,legacy_item_code,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status"),
  loadAll("products", "id,sku"),
  loadAll("fulfillments", "shipping_order_line_id,fulfilled_qty"),
  loadAll("order_shipment_lines", "shipping_order_line_id,quantity"),
  loadAll("inventory_allocations", "shipping_order_line_id,quantity,allocation_status"),
  loadAll("inventory_transactions", "shipping_order_line_id"),
]);

const productsById = new Map(products.map((product) => [product.id, product]));
const linesByOrder = groupBy(lines, "shipping_order_id");
const fulfillmentsByLine = groupBy(fulfillments, "shipping_order_line_id");
const shipmentLinesByLine = groupBy(shipmentLines, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const transactionsByLine = groupBy(transactions.filter((row) => row.shipping_order_line_id), "shipping_order_line_id");
const activeBySource = groupBy(orders.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id), "source_invoice_id");

const candidates = [];
for (const siblings of activeBySource.values()) {
  const qbo = siblings.find((order) => order.source_type === "QBO_INVOICE" && TARGET_INVOICES.has(String(order.order_number)));
  const oldErp = siblings.find((order) => (order.source_system === "OLD_ERP" || order.source_type === "INTERNAL") && String(order.order_number) === String(qbo?.order_number));
  if (!qbo || !oldErp) continue;
  const qboCustomer = qbo.customers?.company_name ?? qbo.customers?.full_name ?? qbo.legacy_customer_name ?? null;
  const oldCustomer = oldErp.customers?.company_name ?? oldErp.customers?.full_name ?? oldErp.legacy_customer_name ?? null;
  const qboLines = summarize(linesByOrder.get(qbo.id) ?? [], productsById, fulfillmentsByLine, shipmentLinesByLine, allocationsByLine, transactionsByLine);
  const oldLines = summarize(linesByOrder.get(oldErp.id) ?? [], productsById, fulfillmentsByLine, shipmentLinesByLine, allocationsByLine, transactionsByLine);
  const sameCustomer = upper(qboCustomer) === upper(oldCustomer);
  const sameDemand = matchingObligation(qboLines, oldLines);
  const staleHasIndependentEvidence = oldLines.some((line) => line.fulfilledQty > 0 || line.fulfillmentLedgerQty > 0 || line.shipmentQty > 0 || line.activeAllocationQty > 0 || line.inventoryTransactionCount > 0);
  const disposition = sameCustomer && sameDemand && !staleHasIndependentEvidence
    ? "SAFE_TO_RETIRE_STALE_PARENT"
    : sameCustomer && sameDemand
      ? "MANUAL_REVIEW"
      : "KEEP_BOTH";
  candidates.push({
    invoice: qbo.order_number,
    disposition,
    rationale: disposition === "SAFE_TO_RETIRE_STALE_PARENT"
      ? "The QBO parent is canonical and has the identical active customer obligation. The OLD_ERP parent has no fulfillment, shipment, active allocation, or inventory evidence that retirement would hide."
      : disposition === "MANUAL_REVIEW"
        ? "The obligation matches, but the OLD_ERP parent retains independent historical or allocation evidence that must remain visible."
        : "Customer, SKU/product, ordered quantity, or approved quantity differs; both parents represent distinct or unproven demand.",
    customer: { qbo: qboCustomer, oldErp: oldCustomer, matches: sameCustomer },
    sourceIdentity: { qbo: qbo.source_invoice_id, oldErp: oldErp.source_invoice_id, matches: qbo.source_invoice_id === oldErp.source_invoice_id },
    canonicalQboParent: { id: qbo.id, lines: qboLines },
    staleOldErpParent: { id: oldErp.id, lines: oldLines },
    comparison: { sameDemand, staleHasIndependentEvidence },
  });
}

if (candidates.length !== TARGET_INVOICES.size) throw new Error(`Expected ${TARGET_INVOICES.size} candidates, found ${candidates.length}.`);
candidates.sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)));
const report = { generatedAt: new Date().toISOString(), readOnly: true, candidates };
fs.writeFileSync("tmp/import-reports/operational-duplicate-parent-candidate-review.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  readOnly: true,
  candidates: candidates.map((candidate) => ({
    invoice: candidate.invoice,
    disposition: candidate.disposition,
    rationale: candidate.rationale,
    customer: candidate.customer,
    canonicalQboParent: candidate.canonicalQboParent,
    staleOldErpParent: candidate.staleOldErpParent,
  })),
  report: "tmp/import-reports/operational-duplicate-parent-candidate-review.json",
}, null, 2));