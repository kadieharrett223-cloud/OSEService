#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const EXPORT_PATH = "tmp/exports/azure-FulfilledInvoiceRows-2026-08-25T21-35-59-530Z.json";
const OUTPUT_PATH = "tmp/import-reports/exact-cosmos-fulfilled-demand-reconciliation.json";
const MANUAL_11540_SOURCE = "51e73fa4-bc55-4ee2-8e4f-e7aa95e4b672";
const CLOSED = new Set(["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase credentials. Run with --env-file=.env.local.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
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

function identity(line) {
  if (line.qbo_invoice_line_id) return `QBO_LINE:${line.qbo_invoice_line_id}`;
  if (line.source_record_id) return `SOURCE:${line.source_record_id}`;
  return `LINE:${line.id}`;
}

const cosmos = JSON.parse(fs.readFileSync(EXPORT_PATH, "utf8"));
const [products, aliases, orders, lines, transactions, resolutions, containerLines] = await Promise.all([
  loadAll("products", "id,sku,canonical_name"),
  loadAll("product_aliases", "product_id,alias"),
  loadAll("shipping_orders", "id,order_number,review_status,duplicate_of_order_id,cancellation_status,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,qbo_invoice_line_id,source_record_id,legacy_item_code,approved_qty,fulfilled_qty,approval_status,fulfillment_status"),
  loadAll("inventory_transactions", "product_id,bucket,delta"),
  loadAll("reviewed_obligation_resolutions", "source_record_id,qbo_invoice_line_id,status"),
  loadAll("container_lines", "product_id,on_order_qty,received_qty,containers(lifecycle_status)"),
]);

const orderById = new Map(orders.map((order) => [order.id, order]));
const productById = new Map(products.map((product) => [product.id, product]));
const activeSourceResolutions = new Set(resolutions.filter((row) => upper(row.status || "ACTIVE") === "ACTIVE").map((row) => row.source_record_id).filter(Boolean));
const activeQboResolutions = new Set(resolutions.filter((row) => upper(row.status || "ACTIVE") === "ACTIVE").map((row) => row.qbo_invoice_line_id).filter(Boolean));
const cosmosBySource = new Map(cosmos.map((row) => [row.queueItemId, row]));
const open = (line) => {
  const order = orderById.get(line.shipping_order_id);
  return number(line.approved_qty) > number(line.fulfilled_qty)
    && !CLOSED.has(upper(line.approval_status))
    && !CLOSED.has(upper(line.fulfillment_status))
    && !order?.duplicate_of_order_id
    && upper(order?.cancellation_status) !== "CANCELLED"
    && !["ARCHIVED", "FULFILLED", "SHIPPED"].includes(upper(order?.review_status))
    && !activeSourceResolutions.has(line.source_record_id)
    && !activeQboResolutions.has(line.qbo_invoice_line_id);
};

const exactCandidates = lines.filter((line) => line.source_record_id && cosmosBySource.has(line.source_record_id) && open(line)).map((line) => {
  const source = cosmosBySource.get(line.source_record_id);
  const order = orderById.get(line.shipping_order_id);
  return {
    sourceRecordId: line.source_record_id,
    lineId: line.id,
    invoice: source.invoiceNumber,
    customer: order?.customers?.company_name ?? order?.customers?.full_name ?? order?.legacy_customer_name ?? source.customerName,
    sku: line.legacy_item_code ?? source.itemCode,
    productId: line.product_id,
    quantity: Math.min(number(source.qty), number(line.approved_qty) - number(line.fulfilled_qty)),
    cosmosFulfilledAt: source.fulfilledAt,
    cosmosFulfilledBy: source.fulfilledBy,
  };
});

const dedupedOpen = new Map();
for (const line of lines.filter(open)) {
  const key = identity(line);
  const existing = dedupedOpen.get(key);
  if (!existing || number(line.approved_qty) - number(line.fulfilled_qty) > number(existing.approved_qty) - number(existing.fulfilled_qty)) dedupedOpen.set(key, line);
}
const floorByProduct = new Map();
for (const row of transactions.filter((row) => row.bucket === "ON_FLOOR")) floorByProduct.set(row.product_id, (floorByProduct.get(row.product_id) ?? 0) + number(row.delta));
const incomingByProduct = new Map();
for (const row of containerLines) {
  if (!row.product_id || !["ON_ORDER", "IN_TRANSIT", "AT_PORT", "RECEIVING"].includes(upper(row.containers?.lifecycle_status))) continue;
  incomingByProduct.set(row.product_id, (incomingByProduct.get(row.product_id) ?? 0) + Math.max(0, number(row.on_order_qty) - number(row.received_qty)));
}
const candidateByProduct = new Map();
for (const candidate of exactCandidates) candidateByProduct.set(candidate.productId, [...(candidateByProduct.get(candidate.productId) ?? []), candidate]);
const rows = [...candidateByProduct.entries()].map(([productId, candidates]) => {
  const product = productById.get(productId);
  const sold = [...dedupedOpen.values()].filter((line) => line.product_id === productId).reduce((sum, line) => sum + Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty)), 0);
  const removal = candidates.reduce((sum, candidate) => sum + candidate.quantity, 0);
  const onFloor = floorByProduct.get(productId) ?? 0;
  const incoming = incomingByProduct.get(productId) ?? 0;
  return {
    sku: candidates[0].sku ?? product?.sku,
    storedProductSku: product?.sku ?? null,
    productId,
    currentSold: sold,
    exactSourceResurrectedQty: removal,
    projectedSold: Math.max(0, sold - removal),
    onFloor,
    projectedAvailableNow: Math.max(0, onFloor - Math.max(0, sold - removal)),
    incoming,
    projectedAvailableIncoming: onFloor + incoming - Math.max(0, sold - removal),
    affected: candidates.map(({ sourceRecordId, invoice, customer, quantity, cosmosFulfilledAt, cosmosFulfilledBy }) => ({ sourceRecordId, invoice, customer, quantity, cosmosFulfilledAt, cosmosFulfilledBy })),
  };
}).sort((left, right) => String(left.sku).localeCompare(String(right.sku)));

const prior = JSON.parse(fs.readFileSync("tmp/import-reports/cosmos-fulfilled-supabase-reconciliation.json", "utf8"));
const ambiguous = prior.potentialResurrected.filter((row) => row.matchMethod !== "EXACT_SOURCE_RECORD_ID");
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  matchingRule: "Cosmos FulfilledInvoiceRows.queueItemId equals Supabase shipping_order_lines.source_record_id only.",
  safeExactSourceRepairs: { rows, candidateCount: exactCandidates.length, candidateQty: exactCandidates.reduce((sum, candidate) => sum + candidate.quantity, 0) },
  ambiguousManualReview: {
    quarantinedDebugUiRows: ambiguous.filter((row) => upper(row.cosmos?.fulfilledBy) === "DEBUG-UI").length,
    quarantinedSiblingRows: ambiguous.filter((row) => upper(row.cosmos?.fulfilledBy) !== "DEBUG-UI").length,
    manualConfirmed11540: { sourceRecordId: MANUAL_11540_SOURCE, invoice: "11540", customer: "Dustin Resleff", sku: "4PXL-10", quantity: 2, status: "MANUAL CONFIRMATION - SEPARATE APPROVAL REQUIRED" },
  },
  exclusions: { alreadyResolvedExactSources: 17, noFuzzyOrInvoiceSkuRepairPopulation: true },
};
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath: OUTPUT_PATH, exactCandidateCount: report.safeExactSourceRepairs.candidateCount, exactCandidateQty: report.safeExactSourceRepairs.candidateQty, skuRows: rows.length, quarantinedDebugUiRows: report.ambiguousManualReview.quarantinedDebugUiRows, quarantinedSiblingRows: report.ambiguousManualReview.quarantinedSiblingRows }, null, 2));