import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

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

function productSummary(lines, productsById, fulfillmentByLine, shipmentByLine, allocationsByLine) {
  const products = new Map();
  for (const line of lines) {
    const key = line.product_id ?? `UNMAPPED:${line.id}`;
    const current = products.get(key) ?? { productId: line.product_id ?? null, sku: productsById.get(line.product_id)?.sku ?? line.legacy_item_code ?? "Unmapped", ordered: 0, approved: 0, fulfilled: 0, shipmentQuantity: 0, fulfillmentQuantity: 0, allocated: 0, lineIds: [] };
    current.ordered += Math.max(number(line.ordered_qty), number(line.approved_qty));
    current.approved += number(line.approved_qty);
    current.fulfilled += number(line.fulfilled_qty);
    current.shipmentQuantity += (shipmentByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.quantity), 0);
    current.fulfillmentQuantity += (fulfillmentByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.fulfilled_qty), 0);
    current.allocated += (allocationsByLine.get(line.id) ?? []).filter((row) => upper(row.allocation_status) === "ALLOCATED").reduce((sum, row) => sum + number(row.quantity), 0);
    current.lineIds.push(line.id);
    products.set(key, current);
  }
  return [...products.values()].map((product) => ({ ...product, remaining: Math.max(0, product.approved - product.fulfilled) })).sort((left, right) => left.sku.localeCompare(right.sku));
}

function sameProductObligation(qboProducts, oldErpProducts) {
  if (qboProducts.length !== oldErpProducts.length) return false;
  const oldByProduct = new Map(oldErpProducts.map((product) => [product.productId ?? product.sku, product]));
  return qboProducts.every((product) => {
    const old = oldByProduct.get(product.productId ?? product.sku);
    return old && product.ordered === old.ordered;
  });
}

const [orders, lines, products, fulfillments, shipmentLines, allocations] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,legacy_item_code,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status"),
  loadAll("products", "id,sku"),
  loadAll("fulfillments", "shipping_order_line_id,fulfilled_qty,fulfillment_type"),
  loadAll("order_shipment_lines", "shipping_order_line_id,quantity"),
  loadAll("inventory_allocations", "shipping_order_line_id,quantity,allocation_status"),
]);

const productsById = new Map(products.map((product) => [product.id, product]));
const linesByOrder = groupBy(lines, "shipping_order_id");
const fulfillmentByLine = groupBy(fulfillments, "shipping_order_line_id");
const shipmentByLine = groupBy(shipmentLines, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const activeBySource = groupBy(orders.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id), "source_invoice_id");

const pairs = [];
for (const [sourceInvoiceId, siblings] of activeBySource) {
  const canonical = siblings.find((order) => order.source_type === "QBO_INVOICE");
  if (!canonical) continue;
  const qboCustomer = canonical.customers?.company_name ?? canonical.customers?.full_name ?? canonical.legacy_customer_name ?? null;
  for (const oldErp of siblings.filter((order) => order.source_system === "OLD_ERP" || order.source_type === "INTERNAL")) {
    const oldCustomer = oldErp.customers?.company_name ?? oldErp.customers?.full_name ?? oldErp.legacy_customer_name ?? null;
    const qboProducts = productSummary(linesByOrder.get(canonical.id) ?? [], productsById, fulfillmentByLine, shipmentByLine, allocationsByLine);
    const oldProducts = productSummary(linesByOrder.get(oldErp.id) ?? [], productsById, fulfillmentByLine, shipmentByLine, allocationsByLine);
    const sameCustomer = upper(qboCustomer) === upper(oldCustomer);
    const sameProductsAndOrderedQuantity = sameProductObligation(qboProducts, oldProducts);
    const sameObligation = sameCustomer && sameProductsAndOrderedQuantity;
    pairs.push({
      invoice: canonical.order_number ?? oldErp.order_number ?? "Unknown",
      sourceInvoiceId,
      determination: sameObligation ? "SAME_REAL_CUSTOMER_OBLIGATION" : "DIFFERENT_DEMAND_OR_INSUFFICIENT_MATCH",
      disposition: sameObligation ? "QBO is canonical; OLD_ERP is a stale representation only if separate fulfillment/shipment/allocation evidence is individually cleared." : "Keep both preserved parents; SKU or ordered-quantity evidence differs.",
      customer: { qbo: qboCustomer, oldErp: oldCustomer, matches: sameCustomer },
      canonicalQboParent: { id: canonical.id, sourceType: canonical.source_type, sourceSystem: canonical.source_system, products: qboProducts },
      oldErpParent: { id: oldErp.id, sourceType: oldErp.source_type, sourceSystem: oldErp.source_system, products: oldProducts },
      comparison: { sharedImmutableSourceIdentity: canonical.source_invoice_id === oldErp.source_invoice_id, sameProductsAndOrderedQuantity },
    });
  }
}

pairs.sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)) || left.oldErpParent.id.localeCompare(right.oldErpParent.id));
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  invariant: "No parent is modified. QBO is canonical for shared immutable QBO invoice identity. An exact customer plus SKU/product and ordered-quantity match establishes the same real obligation; fulfillment, shipment, and allocation evidence remains preserved for individual review.",
  summary: {
    totalPairs: pairs.length,
    sameRealCustomerObligation: pairs.filter((pair) => pair.determination === "SAME_REAL_CUSTOMER_OBLIGATION").length,
    differentDemandOrInsufficientMatch: pairs.filter((pair) => pair.determination === "DIFFERENT_DEMAND_OR_INSUFFICIENT_MATCH").length,
  },
  pairs,
};
fs.writeFileSync("tmp/import-reports/duplicate-parent-obligation-comparison-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, summary: report.summary, sameObligationInvoices: pairs.filter((pair) => pair.determination === "SAME_REAL_CUSTOMER_OBLIGATION").map((pair) => pair.invoice), differentDemandInvoices: pairs.filter((pair) => pair.determination === "DIFFERENT_DEMAND_OR_INSUFFICIENT_MATCH").map((pair) => pair.invoice), report: "tmp/import-reports/duplicate-parent-obligation-comparison-audit.json" }, null, 2));