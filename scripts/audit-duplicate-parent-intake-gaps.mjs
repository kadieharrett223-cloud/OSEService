import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const input = JSON.parse(fs.readFileSync("tmp/import-reports/operational-duplicate-parent-demand-audit.json", "utf8"));
const upper = (value) => String(value ?? "").trim().toUpperCase();
const number = (value) => Number(value ?? 0);
const PAID = new Set(["PAID", "PARTIALLY PAID"]);
const CLOSED = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

async function loadByIds(table, select, column, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await db.from(table).select(select).in(column, ids.slice(index, index + 100));
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

function skuCandidates(value) {
  const raw = upper(value);
  if (!raw) return [];
  const candidates = [raw];
  if (/\(DELETED/.test(raw)) {
    let live = raw.replace(/\s*\(DELETED[^)]*\)\s*$/, "").trim();
    candidates.push(live);
    while (/[-\s]1$/.test(live)) {
      live = live.replace(/[-\s]1$/, "").trim();
      candidates.push(live);
    }
  }
  return [...new Set(candidates.map((candidate) => candidate.replace(/[^A-Z0-9]/g, "")).filter(Boolean))];
}

function isPhysical(line) {
  return number(line.ordered_qty) > 0
    && !/discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b|misc(?:ellaneous)?\s+charge/i.test(`${line.qbo_sku ?? ""} ${line.source_description ?? ""}`);
}

const sourceLineIds = [...new Set(input.conflicts
  .flatMap((conflict) => conflict.obligations)
  .filter((obligation) => obligation.sourceIntakeGap)
  .map((obligation) => obligation.identity.replace("QBO_LINE:", "")))];
const [qboLines, orders, resolutions, mappingRows] = await Promise.all([
  loadByIds("qbo_invoice_lines", "id,qbo_invoice_id,qbo_sku,source_description,ordered_qty,product_id,qbo_invoices(invoice_number,payment_status,raw_payload,customers(company_name,full_name))", "id", sourceLineIds),
  loadByIds("shipping_orders", "id,order_number,source_invoice_id,review_status,cancellation_status,first_payment_at", "source_invoice_id", [...new Set(input.conflicts.map((conflict) => conflict.sourceInvoiceId))]),
  loadByIds("reviewed_obligation_resolutions", "qbo_invoice_line_id,status,resolution_type", "qbo_invoice_line_id", sourceLineIds),
  loadByIds("manual_product_mapping_queue", "source_record_id,status", "source_record_id", sourceLineIds),
]);

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}
const [allProducts, allAliases] = await Promise.all([loadAll("products", "id,sku"), loadAll("product_aliases", "product_id,alias")]);
const productIdBySku = new Map();
for (const product of allProducts) for (const key of skuCandidates(product.sku)) productIdBySku.set(key, product.id);
for (const alias of allAliases) for (const key of skuCandidates(alias.alias)) productIdBySku.set(key, alias.product_id);
const lines = await loadByIds("shipping_order_lines", "id,shipping_order_id,qbo_invoice_line_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status", "qbo_invoice_line_id", sourceLineIds);
const linesByQboId = new Map();
for (const line of lines) linesByQboId.set(line.qbo_invoice_line_id, [...(linesByQboId.get(line.qbo_invoice_line_id) ?? []), line]);
const orderById = new Map(orders.map((order) => [order.id, order]));
const activeResolutionIds = new Set(resolutions.filter((resolution) => upper(resolution.status) === "ACTIVE").map((resolution) => resolution.qbo_invoice_line_id));
const openMappingIds = new Set(mappingRows.filter((row) => upper(row.status) === "OPEN").map((row) => row.source_record_id));

const gaps = qboLines.map((source) => {
  const representations = linesByQboId.get(source.id) ?? [];
  const productId = source.product_id ?? skuCandidates(source.qbo_sku).map((key) => productIdBySku.get(key)).find(Boolean) ?? null;
  const invoice = source.qbo_invoices;
  const paid = PAID.has(upper(invoice?.payment_status));
  const terminal = activeResolutionIds.has(source.id) || representations.some((line) => CLOSED.has(upper(line.fulfillment_status)) || number(line.fulfilled_qty) >= number(source.ordered_qty));
  const hasApprovedOpenRepresentation = representations.some((line) => number(line.approved_qty) > 0 && !CLOSED.has(upper(line.fulfillment_status)));
  const pendingOnly = representations.length > 0 && !hasApprovedOpenRepresentation;
  let classification = "NOT_CURRENTLY_ELIGIBLE";
  if (terminal) classification = "TERMINAL_OR_REVIEWED";
  else if (!isPhysical(source)) classification = "NON_INVENTORY";
  else if (!paid) classification = "UNPAID_OR_PAYMENT_UNVERIFIED";
  else if (!productId) classification = openMappingIds.has(source.id) ? "MAPPING_REVIEW_QUEUED" : "MAPPING_REVIEW_MISSING";
  else if (hasApprovedOpenRepresentation) classification = "ALREADY_CANONICAL";
  else if (pendingOnly) classification = "PAID_MAPPED_PENDING_ACTIVATION";
  else classification = "PAID_MAPPED_UNREPRESENTED";
  return {
    invoice: invoice?.invoice_number ?? null,
    qboInvoiceLineId: source.id,
    sku: source.qbo_sku,
    quantity: number(source.ordered_qty),
    paymentStatus: invoice?.payment_status ?? null,
    productId,
    firstPaymentAt: representations.map((line) => orderById.get(line.shipping_order_id)?.first_payment_at).find(Boolean) ?? null,
    classification,
    representations: representations.map((line) => ({ id: line.id, approvedQty: number(line.approved_qty), fulfilledQty: number(line.fulfilled_qty), approvalStatus: line.approval_status, fulfillmentStatus: line.fulfillment_status, warehouseStatus: line.warehouse_status, parentReviewStatus: orderById.get(line.shipping_order_id)?.review_status ?? null })),
  };
}).sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)) || String(left.sku).localeCompare(String(right.sku)));

const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  scope: "QBO source lines identified as pending/unrepresented intake gaps by the operational duplicate-parent demand audit.",
  summary: Object.fromEntries(Object.entries(Object.groupBy(gaps, (gap) => gap.classification)).map(([classification, rows]) => [classification, rows.length])),
  currentCustomerOrdersNeedingReview: gaps.filter((gap) => gap.classification === "PAID_MAPPED_PENDING_ACTIVATION" || gap.classification === "PAID_MAPPED_UNREPRESENTED"),
  gaps,
};
fs.writeFileSync("tmp/import-reports/duplicate-parent-intake-gaps-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, summary: report.summary, currentCustomerOrdersNeedingReview: report.currentCustomerOrdersNeedingReview, report: "tmp/import-reports/duplicate-parent-intake-gaps-audit.json" }, null, 2));