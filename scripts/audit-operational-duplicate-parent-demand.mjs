import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLOSED = new Set(["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);
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

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
  return groups;
}

function skuKeys(value) {
  const raw = upper(value);
  if (!raw) return [];
  const values = [raw];
  if (/\(DELETED/.test(raw)) {
    let live = raw.replace(/\s*\(DELETED[^)]*\)\s*$/, "").trim();
    values.push(live);
    while (/[-\s]1$/.test(live)) {
      live = live.replace(/[-\s]1$/, "").trim();
      values.push(live);
    }
  }
  return [...new Set(values.map((item) => item.replace(/[^A-Z0-9]/g, "")).filter(Boolean))];
}

function sameSku(left, right) {
  return skuKeys(left).some((key) => skuKeys(right).includes(key));
}

function isPhysicalQboLine(line) {
  return number(line.ordered_qty) > 0
    && !/discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b|misc(?:ellaneous)?\s+charge/i.test(`${line.qbo_sku ?? ""} ${line.source_description ?? ""}`);
}

function isOpen(line, provenFulfilled) {
  return Math.max(0, number(line.approved_qty) - provenFulfilled) > 0
    && !CLOSED.has(upper(line.approval_status))
    && !CLOSED.has(upper(line.fulfillment_status));
}

function isOperational(order, lines, allocationsByLine) {
  if (upper(order.cancellation_status) === "CANCELLED" || ["ARCHIVED", "FULFILLED", "SHIPPED"].includes(upper(order.review_status))) return false;
  return lines.some((line) => {
    const open = Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty));
    const allocated = (allocationsByLine.get(line.id) ?? []).some((allocation) => upper(allocation.allocation_status) === "ALLOCATED" && number(allocation.quantity) > 0);
    return (open > 0 && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) && !CLOSED.has(upper(line.fulfillment_status))) || allocated;
  });
}

const [orders, lines, qboLines, products, aliases, fulfillments, allocations, resolutions] = await Promise.all([
  loadAll("shipping_orders", "id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,cancellation_status,review_status,legacy_customer_name,customers(company_name,full_name)"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,qbo_invoice_line_id,source_record_id,legacy_item_code,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status"),
  loadAll("qbo_invoice_lines", "id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id"),
  loadAll("products", "id,sku"),
  loadAll("product_aliases", "product_id,alias"),
  loadAll("fulfillments", "shipping_order_line_id,fulfilled_qty"),
  loadAll("inventory_allocations", "shipping_order_line_id,quantity,allocation_status"),
  loadAll("reviewed_obligation_resolutions", "source_record_id,qbo_invoice_line_id,status"),
]);

const linesByOrder = groupBy(lines, "shipping_order_id");
const fulfillmentsByLine = groupBy(fulfillments, "shipping_order_line_id");
const allocationsByLine = groupBy(allocations, "shipping_order_line_id");
const productIdByAlias = new Map();
for (const product of products) if (product.sku) productIdByAlias.set(skuKeys(product.sku)[0], product.id);
for (const alias of aliases) if (alias.alias && alias.product_id) productIdByAlias.set(skuKeys(alias.alias)[0], alias.product_id);
const resolvedQboLines = qboLines.filter(isPhysicalQboLine).map((line) => ({ ...line, resolvedProductId: line.product_id ?? skuKeys(line.qbo_sku).map((key) => productIdByAlias.get(key)).find(Boolean) ?? null }));
const qboLinesByInvoice = groupBy(resolvedQboLines, "qbo_invoice_id");
const activeBySource = groupBy(orders.filter((order) => !order.duplicate_of_order_id && order.source_invoice_id), "source_invoice_id");
const resolvedQboLineIds = new Set(resolutions.filter((resolution) => upper(resolution.status) === "ACTIVE" && resolution.qbo_invoice_line_id).map((resolution) => resolution.qbo_invoice_line_id));
const resolvedSourceRecordIds = new Set(resolutions.filter((resolution) => upper(resolution.status) === "ACTIVE" && resolution.source_record_id).map((resolution) => resolution.source_record_id));

const conflicts = [];
for (const siblings of activeBySource.values()) {
  const qbo = siblings.find((order) => order.source_type === "QBO_INVOICE");
  const oldErp = siblings.find((order) => order.source_system === "OLD_ERP" || order.source_type === "INTERNAL");
  if (!qbo || !oldErp) continue;
  const qboParentLines = linesByOrder.get(qbo.id) ?? [];
  const oldParentLines = linesByOrder.get(oldErp.id) ?? [];
  if (!isOperational(qbo, qboParentLines, allocationsByLine) || !isOperational(oldErp, oldParentLines, allocationsByLine)) continue;
  const sourceLines = qboLinesByInvoice.get(qbo.source_invoice_id) ?? [];
  const identities = new Map(sourceLines.map((source) => [`QBO_LINE:${source.id}`, { source, lines: [] }]));
  for (const line of [...qboParentLines, ...oldParentLines]) {
    const source = line.qbo_invoice_line_id
      ? sourceLines.find((candidate) => candidate.id === line.qbo_invoice_line_id)
      : sourceLines.filter((candidate) => candidate.resolvedProductId === line.product_id || sameSku(candidate.qbo_sku, line.legacy_item_code)).length === 1
        ? sourceLines.find((candidate) => candidate.resolvedProductId === line.product_id || sameSku(candidate.qbo_sku, line.legacy_item_code))
        : null;
    const identity = source ? `QBO_LINE:${source.id}` : line.source_record_id ? `SOURCE:${line.source_record_id}` : `LINE:${line.id}`;
    const group = identities.get(identity) ?? { source: null, lines: [] };
    group.lines.push(line);
    identities.set(identity, group);
  }
  const obligations = [...identities.entries()].map(([identity, group]) => {
    const provenFulfilled = Math.max(0, ...group.lines.map((line) => Math.max(number(line.fulfilled_qty), (fulfillmentsByLine.get(line.id) ?? []).reduce((sum, event) => sum + number(event.fulfilled_qty), 0))));
    const actualQuantity = group.source ? number(group.source.ordered_qty) : Math.max(...group.lines.map((line) => number(line.approved_qty)));
    const reviewedResolved = (group.source && resolvedQboLineIds.has(group.source.id)) || group.lines.some((line) => line.source_record_id && resolvedSourceRecordIds.has(line.source_record_id));
    const expectedRemaining = reviewedResolved ? 0 : Math.max(0, actualQuantity - provenFulfilled);
    const candidates = reviewedResolved ? [] : group.lines.map((line) => ({
      line,
      open: Math.max(0, (group.source && number(line.approved_qty) > 0 ? actualQuantity : number(line.approved_qty)) - provenFulfilled),
    })).filter(({ line, open }) => open > 0 && isOpen(line, provenFulfilled));
    const selected = candidates.sort((left, right) => right.open - left.open || String(left.line.id).localeCompare(String(right.line.id)))[0] ?? null;
    const canonicalRemaining = selected?.open ?? 0;
    const parentRepresentations = new Set(group.lines.map((line) => line.shipping_order_id)).size;
    const sourceIntakeGap = Boolean(group.source) && !reviewedResolved && expectedRemaining !== canonicalRemaining && candidates.length === 0;
    const issue = expectedRemaining !== canonicalRemaining && !sourceIntakeGap ? "REMAINING_QTY_MISMATCH" : null;
    return {
      identity,
      sku: group.source?.qbo_sku ?? group.lines[0]?.legacy_item_code ?? null,
      actualCustomerObligationQty: actualQuantity,
      provenFulfilledQty: provenFulfilled,
      canonicalOpenRemainingQty: canonicalRemaining,
      parentRepresentations,
      selectedRepresentationCount: selected ? 1 : 0,
      lineage: group.source ? "QBO_SOURCE_OBLIGATION" : "OLD_ERP_ONLY_REPRESENTED",
      reviewedResolved,
      sourceIntakeGap,
      issue,
      representations: group.lines.map((line) => ({ parent: line.shipping_order_id === qbo.id ? "QBO" : "OLD_ERP", lineId: line.id, qboInvoiceLineId: line.qbo_invoice_line_id, sourceRecordId: line.source_record_id, approvedQty: number(line.approved_qty), fulfilledQty: number(line.fulfilled_qty), fulfillmentLedgerQty: (fulfillmentsByLine.get(line.id) ?? []).reduce((sum, event) => sum + number(event.fulfilled_qty), 0), warehouseStatus: line.warehouse_status, activeAllocationQty: (allocationsByLine.get(line.id) ?? []).filter((allocation) => upper(allocation.allocation_status) === "ALLOCATED").reduce((sum, allocation) => sum + number(allocation.quantity), 0) })),
    };
  });
  const issues = obligations.filter((obligation) => obligation.issue);
  conflicts.push({ invoice: qbo.order_number, sourceInvoiceId: qbo.source_invoice_id, canonicalQboParentId: qbo.id, oldErpParentId: oldErp.id, correct: issues.length === 0, obligations, issues });
}

conflicts.sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)));
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  invariant: "Each physical QBO invoice line is one customer obligation. Canonical remaining quantity must equal QBO source quantity minus the maximum proven fulfillment across its QBO/OLD_ERP representations, with exactly one selected open representation. Active reviewed resolutions make an obligation terminal. A physical QBO source line with no canonical-eligible representation is an intake/review gap, not a duplicate-parent projection error. Unbridged OLD_ERP demand is preserved, not erroneous, when it is canonically represented.",
  summary: {
    operationalConflictsChecked: conflicts.length,
    correct: conflicts.filter((conflict) => conflict.correct).length,
    demandProjectionProblems: conflicts.filter((conflict) => !conflict.correct).length,
    sourceIntakeOrReviewGaps: conflicts.flatMap((conflict) => conflict.obligations).filter((obligation) => obligation.sourceIntakeGap).length,
  },
  problems: conflicts.filter((conflict) => !conflict.correct).map((conflict) => ({ invoice: conflict.invoice, issues: conflict.issues })),
  conflicts,
};
fs.writeFileSync("tmp/import-reports/operational-duplicate-parent-demand-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ readOnly: true, summary: report.summary, problems: report.problems, report: "tmp/import-reports/operational-duplicate-parent-demand-audit.json" }, null, 2));