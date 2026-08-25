#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { getCanonicalPhysicalOrderSummary } from "../src/lib/orders/physical-fulfillment.ts";

const SKU = "4PXL-10";
const ON_FLOOR = 26;
const INCOMING = 33;
const REVIEWED_FIXTURES = [
  {
    source_record_id: "da25408f-149b-4387-92e9-1591e56c5afb",
    qbo_invoice_line_id: "6f592815-0062-46cd-b308-431ca6392ebc",
    resolution_type: "SKU_CORRECTION",
  },
  {
    source_record_id: "563ea9db-9749-4131-b8c1-e3f1f8de2014",
    qbo_invoice_line_id: "643540d5-6cb4-47e0-885d-f83335eafe2a",
    resolution_type: "DUPLICATE",
  },
  {
    source_record_id: "1752481a-2b8f-4ad2-ae93-efb6c84f24d1",
    resolution_type: "REPLACED",
  },
];

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase credentials. Run with node --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const upper = (value) => String(value ?? "").trim().toUpperCase();
const normalizeSkuKey = (value) => upper(value).replace(/[^A-Z0-9]/g, "");
const normalizeCustomerKey = (value) => normalizeSkuKey(value);
const closedDemandStates = new Set(["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

function withProvenFulfilledQty(line, provenFulfilledQty) {
  return {
    ...line,
    fulfilled_qty: Math.max(0, Number(line.fulfilled_qty ?? 0), Number(provenFulfilledQty ?? 0)),
  };
}

function demandIdentity(line) {
  if (line.qbo_invoice_line_id) return `QBO_LINE:${line.qbo_invoice_line_id}`;
  if (line.logical_demand_key) return `QBO_LINE:${line.logical_demand_key}`;
  if (line.source_record_id) return `SOURCE:${line.source_record_id}`;
  return `LINE:${line.id}`;
}

function getCanonicalOpenDemandLines(lines, completedQboLineIds, completedQboInvoiceIds, reviewedResolutions) {
  const resolvedSourceRecordIds = new Set(reviewedResolutions.map((resolution) => resolution.source_record_id).filter(Boolean));
  const resolvedQboLineIds = new Set(reviewedResolutions.map((resolution) => resolution.qbo_invoice_line_id).filter(Boolean));
  const candidates = lines.filter((line) => !resolvedSourceRecordIds.has(line.source_record_id)
    && !resolvedQboLineIds.has(line.qbo_invoice_line_id)
    && !resolvedQboLineIds.has(line.logical_demand_key)
    && (!line.parent_source_invoice_id || !completedQboInvoiceIds.has(line.parent_source_invoice_id))
    && (line.qbo_invoice_line_id || !line.logical_demand_key || !completedQboLineIds.has(line.logical_demand_key)));
  const fulfilledByIdentity = new Map();
  for (const line of candidates) {
    fulfilledByIdentity.set(demandIdentity(line), Math.max(fulfilledByIdentity.get(demandIdentity(line)) ?? 0, Number(line.fulfilled_qty ?? 0)));
  }
  const deduped = new Map();
  for (const candidate of candidates.map((line) => withProvenFulfilledQty(line, fulfilledByIdentity.get(demandIdentity(line)) ?? 0))) {
    const identity = demandIdentity(candidate);
    const quantity = Math.max(0, Number(candidate.approved_qty ?? 0) - Number(candidate.fulfilled_qty ?? 0));
    const existing = deduped.get(identity);
    const existingQuantity = Math.max(0, Number(existing?.approved_qty ?? 0) - Number(existing?.fulfilled_qty ?? 0));
    const reserved = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(upper(candidate.warehouse_status));
    const existingReserved = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(upper(existing?.warehouse_status));
    if (!existing || quantity > existingQuantity || (quantity === existingQuantity && reserved && !existingReserved)) deduped.set(identity, candidate);
  }
  return [...deduped.values()].filter((line) => {
    const quantity = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    return quantity > 0
      && !line.parent_duplicate_of_order_id
      && upper(line.parent_cancellation_status) !== "CANCELLED"
      && !["ARCHIVED", "FULFILLED", "SHIPPED"].includes(upper(line.parent_review_status))
      && !line.parent_qbo_voided
      && !closedDemandStates.has(upper(line.approval_status))
      && !closedDemandStates.has(upper(line.fulfillment_status));
  });
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function add(map, mapKey, value) {
  map.set(mapKey, [...(map.get(mapKey) ?? []), value]);
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

function customerName(order) {
  return order?.customer_name ?? order?.legacy_customer_name ?? null;
}

function sameCustomer(left, right) {
  const leftKey = normalizeCustomerKey(customerName(left));
  const rightKey = normalizeCustomerKey(customerName(right));
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

const [products, aliases, orders, lines, invoices, qboLines, fulfillments] = await Promise.all([
  loadAll("products", "id,sku,canonical_name"),
  loadAll("product_aliases", "product_id,alias"),
  loadAll("shipping_orders", "id,order_number,source_invoice_id,source_type,duplicate_of_order_id,cancellation_status,review_status,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,legacy_item_code,qbo_invoice_line_id,source_record_id"),
  loadAll("qbo_invoices", "id,invoice_number,raw_payload,customers(company_name,full_name)"),
  loadAll("qbo_invoice_lines", "id,qbo_invoice_id,qbo_sku,product_id,ordered_qty"),
  loadAll("fulfillments", "shipping_order_line_id,fulfilled_qty"),
]);

const productById = new Map(products.map((product) => [product.id, product]));
const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
const orderById = new Map(orders.map((order) => {
  const invoice = invoiceById.get(order.source_invoice_id);
  return [order.id, {
    ...order,
    raw_payload: invoice?.raw_payload ?? null,
    customer_name: order.customers?.company_name ?? order.customers?.full_name ?? invoice?.customers?.company_name ?? invoice?.customers?.full_name ?? order.legacy_customer_name ?? null,
  }];
}));
const fulfilledByLineId = new Map();
for (const fulfillment of fulfillments) {
  fulfilledByLineId.set(
    fulfillment.shipping_order_line_id,
    (fulfilledByLineId.get(fulfillment.shipping_order_line_id) ?? 0) + Math.max(0, Number(fulfillment.fulfilled_qty ?? 0)),
  );
}
const queueLines = lines
  .filter((line) => upper(line.fulfillment_status) !== "CANCELLED")
  .map((line) => withProvenFulfilledQty({
    ...line,
    products: productById.get(line.product_id) ?? null,
    order: orderById.get(line.shipping_order_id) ?? null,
  }, fulfilledByLineId.get(line.id) ?? 0));

const productIdByAlias = new Map();
for (const product of products) if (product.sku) productIdByAlias.set(normalizeSkuKey(product.sku), product.id);
for (const alias of aliases) if (alias.alias && alias.product_id) productIdByAlias.set(normalizeSkuKey(alias.alias), alias.product_id);
const qboLinesByInvoice = new Map();
const qboCandidatesByInvoiceProduct = new Map();
for (const qboLine of qboLines) {
  add(qboLinesByInvoice, qboLine.qbo_invoice_id, qboLine);
  const productId = qboLine.product_id
    ?? qboSkuCandidates(qboLine.qbo_sku).map(normalizeSkuKey).map((candidate) => productIdByAlias.get(candidate)).find(Boolean)
    ?? null;
  add(qboCandidatesByInvoiceProduct, `${qboLine.qbo_invoice_id}|${productId ?? normalizeSkuKey(qboLine.qbo_sku)}`, qboLine);
}
const activeQboParentsByOrderNumber = new Map();
for (const order of [...orderById.values()].filter((order) => order.source_type === "QBO_INVOICE" && !order.duplicate_of_order_id && upper(order.cancellation_status) !== "CANCELLED" && upper(order.raw_payload?.PrivateNote) !== "VOIDED")) {
  add(activeQboParentsByOrderNumber, String(order.order_number), order);
}

const bridgedLines = queueLines.map((line) => {
  const parentFields = {
    parent_duplicate_of_order_id: line.order?.duplicate_of_order_id ?? null,
    parent_cancellation_status: line.order?.cancellation_status ?? null,
    parent_review_status: line.order?.review_status ?? null,
    parent_qbo_voided: upper(line.order?.raw_payload?.PrivateNote) === "VOIDED",
    parent_source_invoice_id: line.order?.source_invoice_id ?? null,
    parent_source_type: line.order?.source_type ?? null,
  };
  const bridgedLine = { ...line, ...parentFields };
  if (bridgedLine.qbo_invoice_line_id || !bridgedLine.product_id) return bridgedLine;
  const qboParent = (activeQboParentsByOrderNumber.get(String(bridgedLine.order?.order_number ?? "")) ?? []).find((candidate) => sameCustomer(bridgedLine.order, candidate));
  const qboInvoiceId = qboParent?.source_invoice_id ?? bridgedLine.order?.source_invoice_id;
  if (!qboInvoiceId) return bridgedLine;
  const directCandidates = qboCandidatesByInvoiceProduct.get(`${qboInvoiceId}|${bridgedLine.product_id}`) ?? [];
  const skuCandidates = (qboLinesByInvoice.get(qboInvoiceId) ?? []).filter((candidate) => {
    const qboKeys = qboSkuCandidates(candidate.qbo_sku).map(normalizeSkuKey);
    const lineKeys = qboSkuCandidates(bridgedLine.legacy_item_code).map(normalizeSkuKey);
    return qboKeys.some((candidateKey) => lineKeys.includes(candidateKey));
  });
  const candidates = directCandidates.length === 1 ? directCandidates : skuCandidates;
  return candidates.length === 1 ? { ...bridgedLine, logical_demand_key: candidates[0].id } : bridgedLine;
});

const linesByOrderId = new Map();
const linesBySourceInvoiceId = new Map();
for (const line of bridgedLines) {
  add(linesByOrderId, line.shipping_order_id, line);
  if (line.order?.source_invoice_id) add(linesBySourceInvoiceId, line.order.source_invoice_id, line);
}
const canonicalLineIdsByOrderId = new Map();
const completedQboLineIds = new Set();
const completedQboInvoiceIds = new Set();
for (const order of orderById.values()) {
  if (order.duplicate_of_order_id || upper(order.cancellation_status) === "CANCELLED" || ["ARCHIVED", "FULFILLED", "SHIPPED"].includes(upper(order.review_status))) {
    if (order.source_invoice_id) completedQboInvoiceIds.add(order.source_invoice_id);
  }
}
for (const [orderId, orderLines] of linesByOrderId) {
  const rawPayload = orderLines[0]?.order?.raw_payload;
  if (!Array.isArray(rawPayload?.Line)) {
    canonicalLineIdsByOrderId.set(orderId, null);
    continue;
  }
  const summary = getCanonicalPhysicalOrderSummary({ rawPayload, lines: orderLines });
  canonicalLineIdsByOrderId.set(orderId, new Set(summary.items.map((item) => item.line?.id).filter(Boolean)));
  if (summary.isComplete) {
    if (orderLines[0]?.order?.source_type === "QBO_INVOICE" && orderLines[0].order.source_invoice_id) completedQboInvoiceIds.add(orderLines[0].order.source_invoice_id);
    for (const item of summary.items) if (item.remaining === 0 && item.line?.qbo_invoice_line_id) completedQboLineIds.add(item.line.qbo_invoice_line_id);
  }
}
for (const [sourceInvoiceId, sourceLines] of linesBySourceInvoiceId) {
  const summary = getCanonicalPhysicalOrderSummary({ rawPayload: invoiceById.get(sourceInvoiceId)?.raw_payload, lines: sourceLines });
  if (!summary.isComplete) continue;
  completedQboInvoiceIds.add(sourceInvoiceId);
  for (const item of summary.items) if (item.remaining === 0 && item.line?.qbo_invoice_line_id) completedQboLineIds.add(item.line.qbo_invoice_line_id);
}

const activeCanonicalLines = bridgedLines.filter((line) => {
  const canonicalIds = canonicalLineIdsByOrderId.get(line.shipping_order_id);
  return (canonicalIds === null || canonicalIds === undefined || canonicalIds.has(line.id))
    && !line.order?.duplicate_of_order_id
    && upper(line.order?.cancellation_status) !== "CANCELLED"
    && upper(line.order?.raw_payload?.PrivateNote) !== "VOIDED";
});
const targetProductIds = new Set(products.filter((product) => upper(product.sku) === SKU).map((product) => product.id));
for (const alias of aliases) if (upper(alias.alias) === SKU) targetProductIds.add(alias.product_id);
const finalLines = getCanonicalOpenDemandLines(activeCanonicalLines, completedQboLineIds, completedQboInvoiceIds, REVIEWED_FIXTURES)
  .filter((line) => targetProductIds.has(line.product_id));
const rows = finalLines.map((line) => ({
  invoice: line.order?.order_number ?? null,
  customer: line.order?.customer_name ?? "Customer pending",
  sourceType: line.order?.source_type ?? null,
  sourceRecordId: line.source_record_id ?? null,
  qboInvoiceLineId: line.qbo_invoice_line_id ?? line.logical_demand_key ?? null,
  identity: line.qbo_invoice_line_id ? `QBO_LINE:${line.qbo_invoice_line_id}` : line.logical_demand_key ? `QBO_LINE:${line.logical_demand_key}` : line.source_record_id ? `SOURCE:${line.source_record_id}` : `LINE:${line.id}`,
  quantity: Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)),
})).sort((left, right) => String(left.invoice).localeCompare(String(right.invoice), undefined, { numeric: true }));
const sold = rows.reduce((sum, row) => sum + row.quantity, 0);

console.log(JSON.stringify({
  readOnly: true,
  fixtureOnly: true,
  reviewedFixtures: REVIEWED_FIXTURES,
  currentCustomerList: rows,
  totals: {
    sold,
    onFloor: ON_FLOOR,
    availableNow: ON_FLOOR - sold,
    incoming: INCOMING,
    availableAfterIncoming: ON_FLOOR + INCOMING - sold,
  },
}, null, 2));