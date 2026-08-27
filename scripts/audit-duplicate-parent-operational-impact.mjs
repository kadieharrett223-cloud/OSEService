import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLOSED = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);
const OPEN_WAREHOUSE_STATES = new Set(["ON_FLOOR", "IN_WAREHOUSE", "IN_CONTAINER", "DROPSHIP", "OTHER"]);
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

function summarize(order, lines, allocationsByLine) {
  const evidence = { activeDemand: 0, warehouseAssigned: 0, partiallyFulfilled: 0, activeAllocations: 0 };
  if (upper(order.cancellation_status) === "CANCELLED" || ["ARCHIVED", "FULFILLED", "SHIPPED"].includes(upper(order.review_status))) {
    return { ...evidence, operational: false };
  }
  for (const line of lines) {
    const remaining = Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty));
    const active = ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) && !CLOSED.has(upper(line.fulfillment_status));
    if (active && remaining > 0) {
      evidence.activeDemand += remaining;
      if (OPEN_WAREHOUSE_STATES.has(upper(line.warehouse_status))) evidence.warehouseAssigned += remaining;
    }
    if (active && number(line.fulfilled_qty) > 0 && remaining > 0) evidence.partiallyFulfilled += remaining;
    evidence.activeAllocations += (allocationsByLine.get(line.id) ?? [])
      .filter((allocation) => upper(allocation.allocation_status) === "ALLOCATED")
      .reduce((sum, allocation) => sum + number(allocation.quantity), 0);
  }
  return { ...evidence, operational: evidence.activeDemand > 0 || evidence.warehouseAssigned > 0 || evidence.partiallyFulfilled > 0 || evidence.activeAllocations > 0 };
}

const [orders, lines, allocations] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,cancellation_status,review_status,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status"),
  loadAll("inventory_allocations", "shipping_order_line_id,quantity,allocation_status"),
]);

const linesByOrder = new Map();
for (const line of lines) linesByOrder.set(line.shipping_order_id, [...(linesByOrder.get(line.shipping_order_id) ?? []), line]);
const allocationsByLine = new Map();
for (const allocation of allocations) allocationsByLine.set(allocation.shipping_order_line_id, [...(allocationsByLine.get(allocation.shipping_order_line_id) ?? []), allocation]);
const activeBySourceInvoice = new Map();
for (const order of orders) {
  if (!order.duplicate_of_order_id && order.source_invoice_id) activeBySourceInvoice.set(order.source_invoice_id, [...(activeBySourceInvoice.get(order.source_invoice_id) ?? []), order]);
}

const conflicts = [];
for (const siblings of activeBySourceInvoice.values()) {
  const canonical = siblings.find((order) => order.source_type === "QBO_INVOICE");
  if (!canonical) continue;
  const canonicalCustomer = canonical.customers?.company_name ?? canonical.customers?.full_name ?? canonical.legacy_customer_name ?? null;
  for (const stale of siblings.filter((order) => order.source_system === "OLD_ERP" || order.source_type === "INTERNAL")) {
    const staleCustomer = stale.customers?.company_name ?? stale.customers?.full_name ?? stale.legacy_customer_name ?? null;
    if (upper(canonicalCustomer) !== upper(staleCustomer)) continue;
    const canonicalLines = linesByOrder.get(canonical.id) ?? [];
    const staleLines = linesByOrder.get(stale.id) ?? [];
    const canonicalProducts = new Set(canonicalLines.map((line) => line.product_id).filter(Boolean));
    const matchingProducts = staleLines.map((line) => line.product_id).filter(Boolean).every((productId) => canonicalProducts.has(productId));
    const canonicalOrdered = canonicalLines.reduce((sum, line) => sum + Math.max(number(line.ordered_qty), number(line.approved_qty)), 0);
    const canonicalFulfilled = canonicalLines.reduce((sum, line) => sum + Math.min(Math.max(number(line.ordered_qty), number(line.approved_qty)), Math.max(0, number(line.fulfilled_qty))), 0);
    const staleFulfilled = staleLines.reduce((sum, line) => sum + Math.min(Math.max(number(line.ordered_qty), number(line.approved_qty)), Math.max(0, number(line.fulfilled_qty))), 0);
    if (canonicalOrdered - canonicalFulfilled === 0 && staleFulfilled === 0 && matchingProducts) continue;

    const canonicalImpact = summarize(canonical, canonicalLines, allocationsByLine);
    const staleImpact = summarize(stale, staleLines, allocationsByLine);
    conflicts.push({
      invoice: canonical.order_number ?? stale.order_number ?? "Unknown",
      sourceInvoiceId: canonical.source_invoice_id,
      canonicalOrderId: canonical.id,
      staleOrderId: stale.id,
      classification: canonicalImpact.operational && staleImpact.operational ? "CURRENTLY_OPERATIONAL" : "HISTORICAL_OR_NON_OPERATIONAL",
      canonical: canonicalImpact,
      oldErp: staleImpact,
    });
  }
}

conflicts.sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)) || left.staleOrderId.localeCompare(right.staleOrderId));
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  rule: "A conflict is currently operational only when both active sibling parents are not cancelled or terminally reviewed and retain open demand, an open warehouse assignment, partial fulfillment with remaining demand, or an active allocation. This mirrors ERP Health's duplicate-parent visibility rule.",
  summary: {
    totalConflicts: conflicts.length,
    currentlyOperational: conflicts.filter((conflict) => conflict.classification === "CURRENTLY_OPERATIONAL").length,
    historicalOrNonOperational: conflicts.filter((conflict) => conflict.classification === "HISTORICAL_OR_NON_OPERATIONAL").length,
  },
  conflicts,
};
fs.writeFileSync("tmp/import-reports/duplicate-parent-operational-impact-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, summary: report.summary, currentlyOperational: conflicts.filter((conflict) => conflict.classification === "CURRENTLY_OPERATIONAL").map((conflict) => ({ invoice: conflict.invoice, canonicalOrderId: conflict.canonicalOrderId, oldErpOrderId: conflict.staleOrderId, canonical: conflict.canonical, oldErp: conflict.oldErp })), report: "tmp/import-reports/duplicate-parent-operational-impact-audit.json" }, null, 2));