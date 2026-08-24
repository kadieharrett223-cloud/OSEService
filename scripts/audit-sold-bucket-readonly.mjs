import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CLOSED = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);
const number = (value) => Number(value ?? 0);
const add = (map, key, quantity) => map.set(key, (map.get(key) ?? 0) + quantity);

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

const [products, transactions, orders, lines, qboLines] = await Promise.all([
  loadAll("products", "id,sku,canonical_name"),
  loadAll("inventory_transactions", "product_id,bucket,delta,source_type,source_event_key,reason"),
  loadAll("shipping_orders", "id,source_invoice_id,duplicate_of_order_id,cancellation_status,qbo_invoices(raw_payload)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,qbo_invoice_line_id,source_record_id"),
  loadAll("qbo_invoice_lines", "id,qbo_invoice_id,product_id,ordered_qty"),
]);

const productById = new Map(products.map((product) => [product.id, product]));
const orderById = new Map(orders.map((order) => [order.id, order]));
const qboLinesByInvoiceProduct = new Map();
for (const qboLine of qboLines) {
  if (!qboLine.product_id) continue;
  const key = `${qboLine.qbo_invoice_id}|${qboLine.product_id}`;
  qboLinesByInvoiceProduct.set(key, [...(qboLinesByInvoiceProduct.get(key) ?? []), qboLine]);
}

const demandByIdentity = new Map();
const ambiguousBridgeLines = [];
for (const line of lines) {
  const order = orderById.get(line.shipping_order_id);
  if (!order || order.duplicate_of_order_id || String(order.cancellation_status ?? "").toUpperCase() === "CANCELLED") continue;
  const voided = String(order.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED";
  if (voided || !line.product_id) continue;
  const approved = number(line.approved_qty);
  const fulfilled = number(line.fulfilled_qty);
  const open = Math.max(0, approved - fulfilled);
  if (open <= 0 || CLOSED.has(String(line.approval_status ?? "").toUpperCase()) || CLOSED.has(String(line.fulfillment_status ?? "").toUpperCase())) continue;

  let identity = line.qbo_invoice_line_id ? `QBO:${line.qbo_invoice_line_id}` : line.source_record_id ? `SOURCE:${line.source_record_id}` : null;
  if (!identity && order.source_invoice_id) {
    const candidates = qboLinesByInvoiceProduct.get(`${order.source_invoice_id}|${line.product_id}`) ?? [];
    if (candidates.length === 1) identity = `QBO:${candidates[0].id}`;
    if (candidates.length > 1) ambiguousBridgeLines.push({ lineId: line.id, productId: line.product_id, sourceInvoiceId: order.source_invoice_id, candidates: candidates.map((candidate) => candidate.id) });
  }
  identity ??= `LINE:${line.id}`;
  const current = demandByIdentity.get(identity);
  if (!current || open > current.openDemand) demandByIdentity.set(identity, { productId: line.product_id, openDemand: open });
}

const outstandingDemandByProduct = new Map();
for (const demand of demandByIdentity.values()) add(outstandingDemandByProduct, demand.productId, demand.openDemand);

const soldByProduct = new Map();
const fulfillmentSoldByProduct = new Map();
const nonFulfillmentSoldByProduct = new Map();
for (const transaction of transactions) {
  if (transaction.bucket !== "SOLD" || !transaction.product_id) continue;
  const delta = number(transaction.delta);
  add(soldByProduct, transaction.product_id, delta);
  if (transaction.source_type === "FULFILLMENT") add(fulfillmentSoldByProduct, transaction.product_id, delta);
  else add(nonFulfillmentSoldByProduct, transaction.product_id, delta);
}

const productIds = new Set([...soldByProduct.keys(), ...outstandingDemandByProduct.keys()]);
const byProduct = [...productIds].map((productId) => {
  const product = productById.get(productId);
  const soldBalance = soldByProduct.get(productId) ?? 0;
  const outstandingDemand = outstandingDemandByProduct.get(productId) ?? 0;
  return {
    productId,
    sku: product?.sku ?? null,
    product: product?.canonical_name ?? null,
    soldTransactionBalance: soldBalance,
    soldWrittenByFulfillment: fulfillmentSoldByProduct.get(productId) ?? 0,
    soldWrittenOutsideFulfillment: nonFulfillmentSoldByProduct.get(productId) ?? 0,
    outstandingCanonicalDemand: outstandingDemand,
    discrepancy: soldBalance - outstandingDemand,
  };
}).sort((left, right) => Math.abs(right.discrepancy) - Math.abs(left.discrepancy) || String(left.sku).localeCompare(String(right.sku)));

const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  definition: "Outstanding canonical demand is active approved demand minus fulfillment, deduplicated by QBO invoice line, bridged only where one invoice/product match exists, or by source-record identity.",
  summary: {
    productsWithSoldBalance: byProduct.filter((row) => row.soldTransactionBalance !== 0).length,
    totalSoldTransactionBalance: byProduct.reduce((sum, row) => sum + row.soldTransactionBalance, 0),
    totalSoldWrittenByFulfillment: byProduct.reduce((sum, row) => sum + row.soldWrittenByFulfillment, 0),
    totalSoldWrittenOutsideFulfillment: byProduct.reduce((sum, row) => sum + row.soldWrittenOutsideFulfillment, 0),
    totalOutstandingCanonicalDemand: byProduct.reduce((sum, row) => sum + row.outstandingCanonicalDemand, 0),
    totalDiscrepancy: byProduct.reduce((sum, row) => sum + row.discrepancy, 0),
    ambiguousBridgeLines: ambiguousBridgeLines.length,
  },
  largestDiscrepancies: byProduct.filter((row) => row.discrepancy !== 0).slice(0, 100),
  byProduct,
  ambiguousBridgeLines,
};

fs.writeFileSync("tmp/import-reports/sold-bucket-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, summary: report.summary, largestDiscrepancies: report.largestDiscrepancies.slice(0, 20), report: "tmp/import-reports/sold-bucket-audit.json" }, null, 2));