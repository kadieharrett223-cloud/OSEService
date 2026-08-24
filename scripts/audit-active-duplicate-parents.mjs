import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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

function summarize(lines) {
  const ordered = lines.reduce((sum, line) => sum + Math.max(number(line.ordered_qty), number(line.approved_qty)), 0);
  const fulfilled = lines.reduce((sum, line) => sum + Math.min(Math.max(number(line.ordered_qty), number(line.approved_qty)), Math.max(0, number(line.fulfilled_qty))), 0);
  return { ordered, fulfilled, remaining: Math.max(0, ordered - fulfilled), productIds: [...new Set(lines.map((line) => line.product_id).filter(Boolean))].sort() };
}

const [orders, lines] = await Promise.all([
  loadAll("shipping_orders", "id, order_number, source_type, source_system, source_invoice_id, duplicate_of_order_id, legacy_customer_name, customers(company_name, full_name)"),
  loadAll("shipping_order_lines", "id, shipping_order_id, product_id, ordered_qty, approved_qty, fulfilled_qty, fulfillment_status"),
]);

const activeOrders = orders.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id);
const linesByOrder = new Map();
for (const line of lines) linesByOrder.set(line.shipping_order_id, [...(linesByOrder.get(line.shipping_order_id) ?? []), line]);
const ordersBySourceInvoice = new Map();
for (const order of activeOrders) ordersBySourceInvoice.set(order.source_invoice_id, [...(ordersBySourceInvoice.get(order.source_invoice_id) ?? []), order]);

const groups = [];
for (const [sourceInvoiceId, siblings] of ordersBySourceInvoice) {
  const qboParents = siblings.filter((order) => order.source_type === "QBO_INVOICE");
  const oldParents = siblings.filter((order) => order.source_system === "OLD_ERP" || order.source_type === "INTERNAL");
  if (qboParents.length === 0 || oldParents.length === 0) continue;

  for (const oldParent of oldParents) {
    const canonical = qboParents[0];
    const canonicalCustomer = canonical.customers?.company_name ?? canonical.customers?.full_name ?? canonical.legacy_customer_name;
    const oldCustomer = oldParent.customers?.company_name ?? oldParent.customers?.full_name ?? oldParent.legacy_customer_name;
    const canonicalSummary = summarize(linesByOrder.get(canonical.id) ?? []);
    const oldSummary = summarize(linesByOrder.get(oldParent.id) ?? []);
    const sameCustomer = normalize(canonicalCustomer) === normalize(oldCustomer);
    const matchingProducts = oldSummary.productIds.every((productId) => canonicalSummary.productIds.includes(productId));
    let category = "CONFLICTING_EVIDENCE";
    let reason = "Open or divergent fulfillment/product evidence requires manual review.";
    if (!sameCustomer) {
      category = "CUSTOMER_COLLISION";
      reason = "Customer identities differ; do not merge automatically.";
    } else if (canonicalSummary.remaining === 0 && oldSummary.fulfilled === 0 && matchingProducts) {
      category = "SAFE_DUPLICATE";
      reason = "Completed QBO parent covers the OLD_ERP products; OLD_ERP parent has no fulfillment evidence.";
    }
    groups.push({
      category,
      reason,
      invoice: canonical.order_number ?? oldParent.order_number,
      sourceInvoiceId,
      canonical: { id: canonical.id, customer: canonicalCustomer ?? null, summary: canonicalSummary },
      oldErp: { id: oldParent.id, customer: oldCustomer ?? null, summary: oldSummary },
    });
  }
}

groups.sort((left, right) => left.category.localeCompare(right.category) || String(left.invoice).localeCompare(String(right.invoice)));
const summary = Object.fromEntries(["SAFE_DUPLICATE", "CONFLICTING_EVIDENCE", "CUSTOMER_COLLISION"].map((category) => [category, groups.filter((group) => group.category === category).length]));
const report = { generatedAt: new Date().toISOString(), readOnly: true, total: groups.length, summary, groups };
fs.writeFileSync("tmp/import-reports/active-duplicate-parent-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, total: report.total, summary: report.summary, affectedInvoices: groups.map((group) => ({ invoice: group.invoice, category: group.category, canonicalOrderId: group.canonical.id, oldErpOrderId: group.oldErp.id })) }, null, 2));