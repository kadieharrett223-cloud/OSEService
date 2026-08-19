import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CLASSIFICATION_FILE = "tmp/duplicate-parent-classification.json";
const OUTPUT_FILE = "tmp/safe-duplicate-parent-reconciliation-preview.json";
const EXPORT_DIR = "tmp/exports";
const REPORT = JSON.parse(fs.readFileSync(CLASSIFICATION_FILE, "utf8"));

if (process.argv.includes("--apply")) {
  throw new Error("This script is preview-only. No apply mode exists yet.");
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function number(value) {
  return Number(value ?? 0);
}

function openQty(line) {
  const closedApproval = ["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"];
  const closedFulfillment = ["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"];
  const approved = number(line.approved_qty);
  const fulfilled = number(line.fulfilled_qty);
  if (approved <= fulfilled) return 0;
  if (closedApproval.includes(String(line.approval_status ?? "").toUpperCase())) return 0;
  if (closedFulfillment.includes(String(line.fulfillment_status ?? "").toUpperCase())) return 0;
  return Math.max(0, approved - fulfilled);
}

function isQueueLine(line) {
  return Boolean(
    line.product_id
      && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase())
      && !["FULFILLED", "CANCELLED"].includes(String(line.fulfillment_status ?? "").toUpperCase()),
  );
}

function quantitySnapshot(line) {
  return {
    ordered: number(line.ordered_qty),
    approved: number(line.approved_qty),
    fulfilled: number(line.fulfilled_qty),
    remaining: openQty(line),
  };
}

function add(map, key, quantity) {
  map.set(key, (map.get(key) ?? 0) + quantity);
}

const queueFiles = fs.readdirSync(EXPORT_DIR)
  .filter((file) => file.endsWith(".json") && (file.toLowerCase().includes("invoicequeue") || file.toLowerCase().includes("invoice-queue")))
  .sort();
const sourceById = new Map();
for (const file of queueFiles) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, file), "utf8")); } catch { continue; }
  const rows = Array.isArray(json) ? json : Object.values(json).find(Array.isArray) ?? [];
  for (const row of rows) {
    if (!row?.id) continue;
    const previous = sourceById.get(row.id);
    if (!previous || String(row.updatedAt ?? "") >= String(previous.updatedAt ?? "")) sourceById.set(row.id, row);
  }
}

const [orders, lines, qboLines, inventoryTransactions, allocations, shipmentLines, containerLines] = await Promise.all([
  loadAll("shipping_orders", "id, order_number, source_type, source_system, source_invoice_id, source_record_id, review_status, created_at, customer_id"),
  loadAll("shipping_order_lines", "id, shipping_order_id, product_id, qbo_invoice_line_id, source_system, source_record_id, source_key, legacy_item_code, ordered_qty, approved_qty, fulfilled_qty, approval_status, fulfillment_status, warehouse_status, queue_position_start, queue_position_count, queue_position_override, queue_position_override_reason"),
  loadAll("qbo_invoice_lines", "id, qbo_invoice_id, qbo_line_id, qbo_sku, product_id, ordered_qty, approval_status, fulfillment_status"),
  loadAll("inventory_transactions", "product_id, bucket, delta"),
  loadAll("inventory_allocations", "shipping_order_line_id, product_id, quantity, source_type, allocation_status"),
  loadAll("order_shipment_lines", "shipment_id, shipping_order_line_id, quantity"),
  loadAll("container_lines", "product_id, on_order_qty, received_qty"),
]);

const ordersById = new Map(orders.map((row) => [row.id, row]));
const linesByOrder = new Map();
for (const line of lines) {
  const bucket = linesByOrder.get(line.shipping_order_id) ?? [];
  bucket.push(line);
  linesByOrder.set(line.shipping_order_id, bucket);
}
const qboLineById = new Map(qboLines.map((line) => [line.id, line]));
const qboLineByInvoiceAndLine = new Map(qboLines.map((line) => [`${line.qbo_invoice_id}:${line.qbo_line_id}`, line]));

const safeGroups = REPORT.classified.filter((group) =>
  group.qboParent
  && !group.hasRisk
  && group.lineResults.length > 0
  && group.lineResults.every((line) => line.classification === "SAME_OBLIGATION"),
);

const retiredParentIds = new Set();
const affectedProductIds = new Set();
const equivalentOldLineIds = new Set();
const equivalentCanonicalLineIds = new Set();
const movedOldLineIds = new Set();
const parentRows = [];
const lineRows = [];
const canonicalRows = [];
const provenanceRows = [];
const stoppedForReview = [];

for (const group of safeGroups) {
  const canonicalParent = ordersById.get(group.qboParent);
  const oldParentIds = new Set(group.lineResults.map((result) => result.orderId));
  const canonicalParentLines = linesByOrder.get(group.qboParent) ?? [];
  const canonicalByQboLineId = new Map(canonicalParentLines.filter((line) => line.qbo_invoice_line_id).map((line) => [line.qbo_invoice_line_id, line]));
  const groupLineRows = [];
  const groupCanonicalRows = [];
  const groupProvenanceRows = [];
  const groupAffectedProductIds = new Set();
  const reasons = [];

  if (!canonicalParent) reasons.push(`Missing canonical parent ${group.qboParent}`);

  for (const result of group.lineResults) {
    const oldLine = lines.find((line) => line.id === result.lineId);
    if (!oldLine) {
      reasons.push(`Missing OLD_ERP line ${result.lineId}`);
      continue;
    }
    const source = sourceById.get(oldLine.source_record_id);
    const qboLine = result.qboLineId ? qboLineByInvoiceAndLine.get(`${group.invoiceId}:${result.qboLineId}`) : null;
    const canonicalLine = qboLine ? canonicalByQboLineId.get(qboLine.id) : null;
    if (!qboLine) {
      reasons.push(`Missing QBO invoice line ${group.invoice}:${result.qboLineId}`);
      continue;
    }
    const operation = canonicalLine ? "MERGE_INTO_EXISTING_QBO_LINE" : "MOVE_EXISTING_OLD_LINE";
    if (canonicalLine && oldLine.product_id !== canonicalLine.product_id) {
      reasons.push(`Product mismatch for ${group.invoice}:${oldLine.id}`);
      continue;
    }

    groupAffectedProductIds.add(oldLine.product_id);
    const oldQuantity = quantitySnapshot(oldLine);
    const canonicalQuantity = canonicalLine ? quantitySnapshot(canonicalLine) : null;
    const projectedQuantity = canonicalLine ? { ...canonicalQuantity } : { ...oldQuantity };
    const unexpectedDifferences = [];
    if (canonicalLine && oldQuantity.remaining !== 0) {
      unexpectedDifferences.push("existing canonical line would not preserve OLD_ERP demand");
      reasons.push(`${group.invoice}:${oldLine.id} has remaining OLD_ERP demand beside an existing canonical line`);
    }
    if (canonicalLine && (canonicalQuantity.fulfilled < 0 || canonicalQuantity.approved < canonicalQuantity.fulfilled)) {
      unexpectedDifferences.push("canonical QBO quantity is internally inconsistent");
      reasons.push(`${group.invoice}:${canonicalLine.id} has inconsistent canonical quantity`);
    }

    const provenance = {
      source_system: oldLine.source_system ?? "OLD_ERP",
      source_record_id: oldLine.source_record_id,
      source_key: oldLine.source_key ?? source?.sourceKey ?? null,
      legacy_item_code: oldLine.legacy_item_code ?? source?.legacySku ?? source?.itemCode ?? null,
    };
    groupLineRows.push({
      invoice: group.invoice,
      oldParentId: oldLine.shipping_order_id,
      oldLineId: oldLine.id,
      canonicalOrderId: group.qboParent,
      canonicalLineId: canonicalLine?.id ?? null,
      canonicalQboLineId: qboLine.id,
      productId: oldLine.product_id,
      operation,
      oldQuantity,
      canonicalQuantity,
      projectedCanonicalQuantity: projectedQuantity,
      provenance,
      unexpectedDifferences,
    });
    groupCanonicalRows.push({
      invoice: group.invoice,
      canonicalOrderId: group.qboParent,
      canonicalLineId: canonicalLine?.id ?? null,
      canonicalQboLineId: qboLine.id,
      productId: canonicalLine?.product_id ?? oldLine.product_id,
      currentProvenance: {
        source_system: canonicalLine?.source_system ?? null,
        source_record_id: canonicalLine?.source_record_id ?? null,
        source_key: canonicalLine?.source_key ?? null,
        legacy_item_code: canonicalLine?.legacy_item_code ?? null,
      },
      receivingProvenance: provenance,
      operation,
    });
    groupProvenanceRows.push({ oldLineId: oldLine.id, canonicalLineId: canonicalLine?.id ?? null, canonicalQboLineId: qboLine.id, provenance, operation });
  }

  if (reasons.length !== 0 || groupLineRows.length !== group.lineResults.length) {
    stoppedForReview.push({
      invoice: group.invoice,
      sourceInvoiceId: group.invoiceId,
      canonicalOrderId: group.qboParent,
      proposedRetiredOrderIds: [...oldParentIds],
      reasons: [...new Set(reasons.length ? reasons : ["Not every OLD_ERP line could be mapped to a canonical shipping line"])],
    });
    continue;
  }

  for (const oldParentId of oldParentIds) retiredParentIds.add(oldParentId);
  for (const productId of groupAffectedProductIds) affectedProductIds.add(productId);
  for (const row of groupLineRows) {
    equivalentOldLineIds.add(row.oldLineId);
    if (row.canonicalLineId) equivalentCanonicalLineIds.add(row.canonicalLineId);
    if (row.operation === "MOVE_EXISTING_OLD_LINE") movedOldLineIds.add(row.oldLineId);
  }
  parentRows.push({
    invoice: group.invoice,
    sourceInvoiceId: group.invoiceId,
    canonicalOrderId: group.qboParent,
    retiredOrderIds: [...oldParentIds],
    canonicalOrderNumber: canonicalParent.order_number,
  });
  lineRows.push(...groupLineRows);
  canonicalRows.push(...groupCanonicalRows);
  provenanceRows.push(...groupProvenanceRows);
}

const equivalenceByLineId = new Map();
for (const row of lineRows) {
  if (row.canonicalLineId) equivalenceByLineId.set(row.oldLineId, row.canonicalLineId);
}

function demandTotals(excludeRetired) {
  const demandByProduct = new Map();
  const queueByProduct = new Map();
  const seen = new Set();
  for (const line of lines) {
    const order = ordersById.get(line.shipping_order_id);
    if (!order || (excludeRetired && retiredParentIds.has(order.id) && !movedOldLineIds.has(line.id))) continue;
    const canonicalLineId = equivalenceByLineId.get(line.id) ?? line.id;
    if (seen.has(canonicalLineId)) continue;
    seen.add(canonicalLineId);
    const quantity = openQty(line);
    if (quantity > 0) add(demandByProduct, line.product_id, quantity);
    if (isQueueLine(line)) add(queueByProduct, line.product_id, quantity);
  }
  return { demandByProduct, queueByProduct };
}

const before = demandTotals(false);
const after = demandTotals(true);
const operationalTotals = {
  fulfilledQty: lines.reduce((sum, line) => sum + number(line.fulfilled_qty), 0),
  inventoryLedgerByBucket: inventoryTransactions.reduce((totals, row) => {
    const bucket = String(row.bucket ?? "UNKNOWN");
    totals[bucket] = (totals[bucket] ?? 0) + number(row.delta);
    return totals;
  }, {}),
  inventoryAllocationQty: allocations.reduce((sum, row) => sum + number(row.quantity), 0),
  shipmentQty: shipmentLines.reduce((sum, row) => sum + number(row.quantity), 0),
  containerOnOrderQty: containerLines.reduce((sum, row) => sum + number(row.on_order_qty), 0),
  containerReceivedQty: containerLines.reduce((sum, row) => sum + number(row.received_qty), 0),
};
const productIds = new Set([...before.demandByProduct.keys(), ...after.demandByProduct.keys(), ...before.queueByProduct.keys(), ...after.queueByProduct.keys()]);
const unexpectedDifferences = [];
for (const productId of productIds) {
  const row = {
    productId,
    activeDemandBefore: before.demandByProduct.get(productId) ?? 0,
    activeDemandAfter: after.demandByProduct.get(productId) ?? 0,
    queueDemandBefore: before.queueByProduct.get(productId) ?? 0,
    queueDemandAfter: after.queueByProduct.get(productId) ?? 0,
  };
  row.activeDemandDifference = row.activeDemandAfter - row.activeDemandBefore;
  row.queueDemandDifference = row.queueDemandAfter - row.queueDemandBefore;
  if (row.activeDemandDifference !== 0 || row.queueDemandDifference !== 0) unexpectedDifferences.push(row);
}

const preview = {
  mode: "PREVIEW_ONLY",
  generatedAt: new Date().toISOString(),
  sourceClassificationGeneratedAt: REPORT.generatedAt,
  safeGroupCount: safeGroups.length,
  retiredParentCount: retiredParentIds.size,
  retiredParentIds: [...retiredParentIds],
  affectedProductIds: [...affectedProductIds].sort(),
  parentsToRetire: parentRows,
  sameObligationLines: lineRows,
  canonicalQboLinesReceivingProvenance: canonicalRows,
  provenanceTransfers: provenanceRows,
  stoppedForReview,
  beforeAfter: {
    activeDemand: {
      before: [...before.demandByProduct.entries()].reduce((sum, [, value]) => sum + value, 0),
      after: [...after.demandByProduct.entries()].reduce((sum, [, value]) => sum + value, 0),
    },
    queueDemand: {
      before: [...before.queueByProduct.entries()].reduce((sum, [, value]) => sum + value, 0),
      after: [...after.queueByProduct.entries()].reduce((sum, [, value]) => sum + value, 0),
    },
    byProduct: [...productIds].sort().map((productId) => ({
      productId,
      activeDemandBefore: before.demandByProduct.get(productId) ?? 0,
      activeDemandAfter: after.demandByProduct.get(productId) ?? 0,
      queueDemandBefore: before.queueByProduct.get(productId) ?? 0,
      queueDemandAfter: after.queueByProduct.get(productId) ?? 0,
    })),
  },
  operationalTotals: {
    before: operationalTotals,
    after: JSON.parse(JSON.stringify(operationalTotals)),
    differences: {
      fulfilledQty: 0,
      inventoryLedgerByBucket: Object.fromEntries(Object.keys(operationalTotals.inventoryLedgerByBucket).map((bucket) => [bucket, 0])),
      inventoryAllocationQty: 0,
      shipmentQty: 0,
      containerOnOrderQty: 0,
      containerReceivedQty: 0,
    },
  },
  unexpectedDifferences,
  invariant: unexpectedDifferences.length === 0
    ? "PASS: logical active demand and queue demand are unchanged"
    : "STOP: at least one product changes demand or queue demand",
  operationalVisibility: {
    before: "All currently loaded shipping_orders are eligible for existing operational classification; duplicate marker is not yet present.",
    projectedRetiredParentCount: retiredParentIds.size,
    projectedVisibleOperationalDecrease: retiredParentIds.size,
    verificationRequiredAfterApply: "Requery operational Orders/Inventory/customer queues and assert the decrease equals retiredParentCount.",
  },
  applyGuard: "No database writes are implemented. A separate reviewed apply operation is required.",
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(preview, null, 2));
console.log(JSON.stringify({
  mode: preview.mode,
  safeGroupCount: preview.safeGroupCount,
  eligibleGroupCount: preview.parentsToRetire.length,
  stoppedForReviewCount: preview.stoppedForReview.length,
  retiredParentCount: preview.retiredParentCount,
  sameObligationLineCount: preview.sameObligationLines.length,
  canonicalQboLineCount: preview.canonicalQboLinesReceivingProvenance.length,
  affectedProductCount: preview.affectedProductIds.length,
  activeDemandBefore: preview.beforeAfter.activeDemand.before,
  activeDemandAfter: preview.beforeAfter.activeDemand.after,
  queueDemandBefore: preview.beforeAfter.queueDemand.before,
  queueDemandAfter: preview.beforeAfter.queueDemand.after,
  unexpectedDifferenceCount: preview.unexpectedDifferences.length,
  invariant: preview.invariant,
  output: OUTPUT_FILE,
}, null, 2));
