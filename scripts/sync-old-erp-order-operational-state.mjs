#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeText,
  pickFirst,
  queueRecordQty,
  timestampSlug,
  toIsoDate,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

function parseArgs(argv) {
  const args = { exportsDir: "tmp/exports", apply: false, reportOut: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--exports-dir") { args.exportsDir = String(argv[index + 1] ?? "").trim() || args.exportsDir; index += 1; }
    if (token === "--apply") args.apply = true;
    if (token === "--report-out") { args.reportOut = String(argv[index + 1] ?? "").trim(); index += 1; }
  }
  return args;
}

async function loadAll(supabase, table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function loadColumnSet(supabase, table, candidates) {
  const columns = new Set();
  for (const column of candidates) {
    const { error } = await supabase.from(table).select(column).limit(1);
    if (!error) columns.add(column);
  }
  return columns;
}

function normalizePriority(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "false" || raw === "no" || raw === "normal") return "NORMAL";
  if (raw.includes("critical") || raw === "p0") return "CRITICAL";
  if (raw.includes("high") || raw === "p1" || raw === "true" || raw === "yes") return "HIGH";
  if (raw.includes("low") || raw === "p3") return "LOW";
  return "NORMAL";
}

function deriveLineState(record) {
  const approval = String(record?.approvalStatus ?? "").trim().toUpperCase();
  const queue = String(record?.queueStatus ?? record?.status ?? "").trim().toUpperCase();
  const warehouse = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  const removed = Boolean(record?.removed || record?.removedAt || record?.removeReason);
  const denied = approval === "DENIED" || queue === "DENIED" || Boolean(record?.denialReason);
  const fulfilled = Boolean(record?.invoiceCompletedAt || record?.fulfilledAt || queue === "FULFILLED" || warehouse === "FULFILLED" || warehouse === "SHIPPED" || warehouse === "COMPLETED");
  const partial = queue === "PARTIALLY_FULFILLED" || warehouse === "PARTIALLY_FULFILLED";

  if (denied || removed && !record?.approvedAt) {
    return { approval_status: denied ? "CANCELLED" : "REMOVED", warehouse_status: "HOLD", fulfillment_status: "CANCELLED" };
  }
  if (removed && record?.approvedAt) {
    return { approval_status: "CANCELLED", warehouse_status: "HOLD", fulfillment_status: "CANCELLED" };
  }
  if (fulfilled) return { approval_status: "FULFILLED", warehouse_status: "FULFILLED", fulfillment_status: "FULFILLED" };
  if (partial) return { approval_status: "PARTIAL", warehouse_status: "PARTIALLY_FULFILLED", fulfillment_status: "PARTIALLY_FULFILLED" };
  if (["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "ON_FLOOR", "ASSIGNED_TO_INBOUND", "HOLD"].includes(warehouse)) {
    return { approval_status: "APPROVED", warehouse_status: warehouse, fulfillment_status: "PENDING" };
  }
  if (approval === "APPROVED" || queue === "APPROVED" || record?.approvedAt) {
    return { approval_status: "APPROVED", warehouse_status: "APPROVED", fulfillment_status: "PENDING" };
  }
  return { approval_status: "PENDING_REVIEW", warehouse_status: "PENDING_REVIEW", fulfillment_status: "PENDING" };
}

function buildPlan(sourceRows, liveLines) {
  const liveBySourceId = new Map(liveLines.filter((row) => row.source_record_id).map((row) => [row.source_record_id, row]));
  const matched = [];
  const missing = [];

  for (const source of sourceRows) {
    const sourceId = normalizeText(source?.id ?? source?._id ?? source?.recordId ?? source?.lineId ?? source?.queueLineId);
    if (!sourceId) continue;
    const live = liveBySourceId.get(sourceId);
    if (!live) {
      missing.push({ sourceRecordId: sourceId, invoiceNumber: source.invoiceNumber, itemCode: source.itemCode });
      continue;
    }

    const state = deriveLineState(source);
    const priority = normalizePriority(source.priorityFlag);
    const sourceQty = queueRecordQty(source);
    const payload = {
      approval_status: state.approval_status,
      warehouse_status: state.warehouse_status,
      fulfillment_status: state.fulfillment_status,
      priority,
      queue_position_start: Number.isFinite(Number(pickFirst(source, ["queuePosition", "queue_position", "queueIndex", "queueOrder", "position"]))) ? Number(pickFirst(source, ["queuePosition", "queue_position", "queueIndex", "queueOrder", "position"])) : null,
      approved_qty: state.approval_status === "APPROVED" || state.approval_status === "FULFILLED" || state.approval_status === "PARTIAL" ? sourceQty : Number(live.approved_qty ?? 0),
      legacy_queue_status: normalizeText(source.queueStatus),
      legacy_warehouse_status: normalizeText(source.warehouseStatus),
      legacy_priority_flag: normalizeText(source.priorityFlag),
      legacy_fulfillment_method: normalizeText(source.fulfillmentMethod),
      legacy_expected_by: toIsoDate(source.expectedBy),
      legacy_qbo_shipping_method: normalizeText(source.qboShippingMethod),
      legacy_floor_assignment: source.floorAssignment ?? null,
    };

    const changes = Object.entries(payload).filter(([key, value]) => String(live[key] ?? "") !== String(value ?? ""));
    if (changes.length > 0) matched.push({ liveLineId: live.id, sourceRecordId: sourceId, invoiceNumber: source.invoiceNumber, itemCode: source.itemCode, payload, changes: changes.map(([field]) => field) });
  }

  return { matched, missing };
}

function highestPriority(lines) {
  const rank = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  return lines.map((line) => line.priority).sort((a, b) => (rank[a] ?? 2) - (rank[b] ?? 2))[0] ?? "NORMAL";
}

async function syncOrders(supabase, orderIds) {
  let ordersUpdated = 0;
  const orderColumns = await loadColumnSet(supabase, "shipping_orders", ["review_status", "fulfillment_status", "priority"]);
  for (const orderId of orderIds) {
    const { data: lines, error: lineError } = await supabase.from("shipping_order_lines").select("approval_status, warehouse_status, fulfillment_status, fulfilled_qty, priority").eq("shipping_order_id", orderId);
    if (lineError) fail(`Could not summarize order ${orderId}: ${lineError.message}`);
    const all = lines ?? [];
    const allFulfilled = all.length > 0 && all.every((line) => line.fulfillment_status === "FULFILLED");
    const anyCancelled = all.some((line) => line.fulfillment_status === "CANCELLED" || line.approval_status === "CANCELLED");
    const anyPartial = all.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED");
    const anyApproved = all.some((line) => ["APPROVED", "PARTIAL", "FULFILLED"].includes(line.approval_status));
    const orderPayload = {
      review_status: allFulfilled ? "FULFILLED" : anyCancelled ? "CANCELLED" : anyApproved ? "APPROVED" : "PENDING_REVIEW",
      fulfillment_status: allFulfilled ? "FULFILLED" : anyPartial ? "PARTIALLY_FULFILLED" : anyCancelled ? "CANCELLED" : "PENDING",
      priority: highestPriority(all),
    };
    const filteredPayload = Object.fromEntries(Object.entries(orderPayload).filter(([key]) => orderColumns.has(key)));
    const { error } = await supabase.from("shipping_orders").update(filteredPayload).eq("id", orderId);
    if (error) fail(`Could not update order summary ${orderId}: ${error.message}`);
    ordersUpdated += 1;
  }
  return ordersUpdated;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir });
  const supabase = createSupabaseAdminClient();
  const liveLines = await loadAll(supabase, "shipping_order_lines", "id, source_record_id, approved_qty, priority, approval_status, warehouse_status, fulfillment_status, shipping_order_id, queue_position_start, legacy_queue_status, legacy_warehouse_status, legacy_priority_flag, legacy_fulfillment_method, legacy_expected_by, legacy_qbo_shipping_method, legacy_floor_assignment");
  const plan = buildPlan(sources.invoiceQueueItems, liveLines);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFile: sources.files.InvoiceQueueItems,
    matchedLiveLinesWithChanges: plan.matched.length,
    missingLiveLines: plan.missing.length,
    sampleChanges: plan.matched.slice(0, 200),
    missingSample: plan.missing.slice(0, 200),
    notes: [
      "Synchronizes OLD_ERP warehouse status, fulfillment status, priority, queue position, expected date, shipping method, notes, and assignment evidence onto matched live OLD_ERP lines.",
      "Recomputes parent order status and priority after line updates.",
      "Does not create inventory allocations or replay inventory adjustments.",
    ],
  };

  if (args.apply) {
    for (const change of plan.matched) {
      const { error } = await supabase.from("shipping_order_lines").update(change.payload).eq("id", change.liveLineId);
      if (error) fail(`Could not sync line ${change.liveLineId}: ${error.message}`);
    }
    const orderIds = Array.from(new Set(plan.matched.map((change) => liveLines.find((line) => line.id === change.liveLineId)?.shipping_order_id).filter(Boolean)));
    report.applyResults = { linesUpdated: plan.matched.length, ordersUpdated: await syncOrders(supabase, orderIds) };
  }

  const reportPath = args.reportOut ? path.resolve(args.reportOut) : path.resolve(`tmp/import-reports/old-erp-order-operational-state-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Order Operational State Sync ===\n");
  console.log({ matchedLiveLinesWithChanges: report.matchedLiveLinesWithChanges, missingLiveLines: report.missingLiveLines, applyResults: report.applyResults ?? null });
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown order operational-state sync failure"));
