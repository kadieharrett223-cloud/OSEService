import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TARGET_INVOICES = new Set(["12254", "125915", "126042", "126151"]);
const number = (value) => Number(value ?? 0);
const normalize = (value) => String(value ?? "").trim().toUpperCase();

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

function summary(lines, productsById, fulfillmentsByLine, shipmentLinesByLine, allocationsByLine, transactionsByLine) {
  const productLines = lines.map((line) => {
    const fulfillmentEvents = fulfillmentsByLine.get(line.id) ?? [];
    const shipmentEvidence = shipmentLinesByLine.get(line.id) ?? [];
    const reservations = allocationsByLine.get(line.id) ?? [];
    const transactions = transactionsByLine.get(line.id) ?? [];
    return {
      lineId: line.id,
      product: productsById.get(line.product_id) ?? { id: line.product_id, sku: null, canonical_name: null },
      orderedQty: number(line.ordered_qty),
      approvedQty: number(line.approved_qty),
      fulfilledQty: number(line.fulfilled_qty),
      remainingQty: Math.max(0, number(line.approved_qty ?? line.ordered_qty) - number(line.fulfilled_qty)),
      approvalStatus: line.approval_status,
      warehouseStatus: line.warehouse_status,
      fulfillmentStatus: line.fulfillment_status,
      queuePosition: line.queue_position_start == null ? null : { start: number(line.queue_position_start), count: number(line.queue_position_count) },
      fulfillmentEvents: fulfillmentEvents.map((event) => ({ id: event.id, quantity: number(event.fulfilled_qty), type: event.fulfillment_type ?? null, shipmentNumber: event.shipment_number ?? null, trackingNumber: event.tracking_number ?? null, fulfilledAt: event.fulfilled_at })),
      shipmentEvidence: shipmentEvidence.map((event) => ({ shipmentId: event.shipment_id, shipmentNumber: event.order_shipments?.shipment_number ?? null, quantity: number(event.quantity), shippedAt: event.order_shipments?.shipped_at ?? null, trackingNumber: event.order_shipments?.tracking_number ?? null })),
      reservations: reservations.map((allocation) => ({ id: allocation.id, quantity: number(allocation.quantity), status: allocation.allocation_status, sourceType: allocation.source_type, container: allocation.containers ? { id: allocation.containers.id, number: allocation.containers.container_number, lifecycleStatus: allocation.containers.lifecycle_status } : null })),
      inventoryTransactions: transactions.map((transaction) => ({ id: transaction.id, bucket: transaction.bucket, delta: number(transaction.delta), sourceType: transaction.source_type, reason: transaction.reason, createdAt: transaction.created_at })),
    };
  });
  return {
    orderedQty: productLines.reduce((sum, line) => sum + line.orderedQty, 0),
    approvedQty: productLines.reduce((sum, line) => sum + line.approvedQty, 0),
    fulfilledQty: productLines.reduce((sum, line) => sum + line.fulfilledQty, 0),
    remainingQty: productLines.reduce((sum, line) => sum + line.remainingQty, 0),
    shipmentEvidenceQty: productLines.flatMap((line) => line.shipmentEvidence).reduce((sum, event) => sum + event.quantity, 0),
    fulfillmentEventQty: productLines.flatMap((line) => line.fulfillmentEvents).reduce((sum, event) => sum + event.quantity, 0),
    fulfillmentEventCount: productLines.flatMap((line) => line.fulfillmentEvents).length,
    shipmentEvidenceCount: productLines.flatMap((line) => line.shipmentEvidence).length,
    activeReservationQty: productLines.flatMap((line) => line.reservations).filter((allocation) => allocation.status === "ALLOCATED").reduce((sum, allocation) => sum + allocation.quantity, 0),
    inventoryTransactionCount: productLines.flatMap((line) => line.inventoryTransactions).length,
    products: productLines,
  };
}

function productQtyById(lines, field) {
  const quantities = new Map();
  for (const line of lines) quantities.set(line.product.id, (quantities.get(line.product.id) ?? 0) + number(line[field]));
  return quantities;
}

const [orders, lines, products, fulfillments, shipmentLines, allocations, transactions] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,queue_position_start,queue_position_count"),
  loadAll("products", "id,sku,canonical_name"),
  loadAll("fulfillments", "id,shipping_order_line_id,fulfilled_qty,fulfilled_at,shipment_number,tracking_number,fulfillment_type"),
  loadAll("order_shipment_lines", "shipment_id,shipping_order_line_id,quantity,order_shipments(shipment_number,shipped_at,tracking_number)"),
  loadAll("inventory_allocations", "id,shipping_order_line_id,quantity,allocation_status,source_type,containers(id,container_number,lifecycle_status)"),
  loadAll("inventory_transactions", "id,shipping_order_line_id,bucket,delta,source_type,reason,created_at"),
]);

const productsById = new Map(products.map((product) => [product.id, product]));
const linesByOrder = groupBy(lines, "shipping_order_id");
const fulfillmentsByLine = groupBy(fulfillments, "shipping_order_line_id");
const shipmentLinesByLine = groupBy(shipmentLines, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const transactionsByLine = groupBy(transactions.filter((transaction) => transaction.shipping_order_line_id), "shipping_order_line_id");
const activeOrders = orders.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id);
const activeBySourceInvoice = groupBy(activeOrders, "source_invoice_id");

const candidates = [];
for (const siblings of activeBySourceInvoice.values()) {
  const canonical = siblings.find((order) => order.source_type === "QBO_INVOICE" && TARGET_INVOICES.has(String(order.order_number)));
  const stale = siblings.find((order) => (order.source_system === "OLD_ERP" || order.source_type === "INTERNAL") && String(order.order_number) === String(canonical?.order_number));
  if (!canonical || !stale) continue;
  const canonicalCustomer = canonical.customers?.company_name ?? canonical.customers?.full_name ?? canonical.legacy_customer_name ?? null;
  const staleCustomer = stale.customers?.company_name ?? stale.customers?.full_name ?? stale.legacy_customer_name ?? null;
  const canonicalSummary = summary(linesByOrder.get(canonical.id) ?? [], productsById, fulfillmentsByLine, shipmentLinesByLine, allocationsByLine, transactionsByLine);
  const staleSummary = summary(linesByOrder.get(stale.id) ?? [], productsById, fulfillmentsByLine, shipmentLinesByLine, allocationsByLine, transactionsByLine);
  const sameCustomer = normalize(canonicalCustomer) === normalize(staleCustomer);
  const sourceInvoiceMatch = canonical.source_invoice_id === stale.source_invoice_id;
  const canonicalFulfilledByProduct = productQtyById(canonicalSummary.products, "fulfilledQty");
  const staleDemandByProduct = productQtyById(staleSummary.products, "approvedQty");
  const staleProductDemandCoveredByCanonicalFulfillment = [...staleDemandByProduct].every(([productId, staleQty]) => number(canonicalFulfilledByProduct.get(productId)) >= staleQty);
  const staleContributesDemand = !stale.duplicate_of_order_id && staleSummary.remainingQty > 0 && staleSummary.products.some((line) => ["APPROVED", "PARTIAL", "FULFILLED"].includes(normalize(line.approvalStatus)) && normalize(line.fulfillmentStatus) !== "CANCELLED");
  const preservesEvidence = sameCustomer
    && sourceInvoiceMatch
    && canonicalSummary.remainingQty === 0
    && staleProductDemandCoveredByCanonicalFulfillment
    && staleSummary.fulfilledQty === 0
    && staleSummary.shipmentEvidenceQty === 0
    && staleSummary.fulfillmentEventQty === 0
    && staleSummary.activeReservationQty === 0
    && staleSummary.inventoryTransactionCount === 0;
  candidates.push({
    invoice: canonical.order_number,
    canonicalQboParentId: canonical.id,
    staleOldErpParentId: stale.id,
    customerIdentity: { canonical: canonicalCustomer, stale: staleCustomer, match: sameCustomer },
    sourceInvoiceId: { canonical: canonical.source_invoice_id, stale: stale.source_invoice_id, match: sourceInvoiceMatch },
    canonical: canonicalSummary,
    staleOldErp: staleSummary,
    staleProductDemandCoveredByCanonicalFulfillment,
    staleParentContributesActiveCustomerListDemand: staleContributesDemand,
    duplicateOfOrderIdOnlyPreservesLegitimateEvidence: preservesEvidence,
    classification: preservesEvidence ? "READY_FOR_APPROVAL" : "NEEDS_MANUAL_REVIEW",
    rationale: preservesEvidence
      ? "Identity matches, fulfilled QBO quantities cover any stale demand, and the stale parent has no fulfillment, shipment, reservation, or inventory transaction evidence to preserve separately."
      : "The stale parent retains operational evidence or the identity/completion proof is incomplete.",
  });
}

if (candidates.length !== TARGET_INVOICES.size) throw new Error(`Expected ${TARGET_INVOICES.size} active candidates, found ${candidates.length}.`);
candidates.sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)));
const report = { generatedAt: new Date().toISOString(), readOnly: true, candidates };
fs.writeFileSync("tmp/import-reports/safe-duplicate-parent-evidence-review.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, candidates: candidates.map((candidate) => ({ invoice: candidate.invoice, classification: candidate.classification, duplicateOfOrderIdOnlyPreservesLegitimateEvidence: candidate.duplicateOfOrderIdOnlyPreservesLegitimateEvidence })) }, null, 2));