#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeSku,
  normalizeText,
  pickFirst,
  queueRecordQty,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

function parseArgs(argv) {
  const args = { exportsDir: "tmp/exports", reportOut: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--exports-dir") {
      args.exportsDir = String(argv[index + 1] ?? "").trim() || args.exportsDir;
      index += 1;
    }
    if (token === "--report-out") {
      args.reportOut = String(argv[index + 1] ?? "").trim();
      index += 1;
    }
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

function sourceId(record) {
  return normalizeText(record?.id ?? record?._id ?? record?.recordId ?? record?.lineId ?? record?.queueLineId);
}

function itemCode(record) {
  return normalizeSku(pickFirst(record, ["matchedItemCode", "matched_item_code", "matchedSku", "itemCode", "item_code", "originalItemCode", "sku"]));
}

function invoiceNumber(record) {
  return normalizeText(pickFirst(record, ["invoiceNumber", "invoice_number", "orderNumber"]));
}

function classifyHistoricalStatus(record) {
  const approval = String(record?.approvalStatus ?? "").trim().toUpperCase();
  const queue = String(record?.queueStatus ?? "").trim().toUpperCase();
  const warehouse = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  const completed = Boolean(record?.invoiceCompletedAt || record?.fulfilledAt || queue === "FULFILLED" || warehouse === "FULFILLED" || warehouse === "SHIPPED");
  const denied = approval === "DENIED" || queue === "DENIED" || normalizeText(record?.denialReason);
  const removed = queue === "REMOVED" || Boolean(record?.removed || record?.removedAt || record?.removeReason);
  const cancelled = queue === "CANCELLED" || String(record?.removeReason ?? "").toLowerCase().includes("cancel");

  if (denied) return "DENIED";
  if (cancelled) return "CANCELLED";
  if (removed) return "REMOVED";
  if (completed && (warehouse === "SHIPPED" || record?.shippedAt)) return "SHIPPED";
  if (completed) return "FULFILLED";
  if (["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED"].includes(warehouse)) return "IN_WAREHOUSE";
  if (approval === "APPROVED" || queue === "APPROVED" || warehouse === "APPROVED" || record?.approvedAt) return "ACCEPTED";
  return "OTHER_CLOSED";
}

function expectedLive(record) {
  const approval = String(record?.approvalStatus ?? "").trim().toUpperCase();
  const queue = String(record?.queueStatus ?? record?.status ?? "").trim().toUpperCase();
  const warehouse = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  const removed = Boolean(record?.removed || record?.removedAt || record?.removeReason);
  const qty = queueRecordQty(record);
  if (removed || approval !== "APPROVED" || qty <= 0) return false;
  if (["FULFILLED", "REMOVED", "DENIED", "CANCELLED"].includes(queue)) return false;
  if (["SHIPPED", "FULFILLED", "CANCELLED"].includes(warehouse)) return false;
  return true;
}

function normalizeQuantity(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizePriority(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "false" || raw === "no" || raw === "normal") return "NORMAL";
  if (raw.includes("critical") || raw === "p0") return "CRITICAL";
  if (raw.includes("high") || raw === "p1" || raw === "true" || raw === "yes") return "HIGH";
  if (raw.includes("low") || raw === "p3") return "LOW";
  return "NORMAL";
}

function compareFields(source, live) {
  const mismatches = [];
  const sourceQty = queueRecordQty(source);
  const liveQty = normalizeQuantity(live?.ordered_qty);
  if (sourceQty !== liveQty) mismatches.push({ field: "quantity", source: sourceQty, live: liveQty });

  const sourceCustomer = normalizeText(source?.customerName);
  const liveCustomer = normalizeText(live?.shipping_orders?.legacy_customer_name);
  if (sourceCustomer && liveCustomer && sourceCustomer.toLowerCase() !== liveCustomer.toLowerCase()) {
    mismatches.push({ field: "customer", source: sourceCustomer, live: liveCustomer });
  }

  const sourcePriority = normalizePriority(source?.priorityFlag);
  const livePriority = normalizePriority(live?.priority);
  if (sourcePriority !== livePriority) {
    mismatches.push({ field: "priority", source: sourcePriority, live: livePriority });
  }

  return mismatches;
}

function buildIndex(rows, keyFn) {
  const index = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const matches = index.get(key) ?? [];
    matches.push(row);
    index.set(key, matches);
  }
  return index;
}

function matchLive(source, liveBySourceId, liveByInvoiceItem) {
  const id = sourceId(source);
  if (id && (liveBySourceId.get(id) ?? []).length === 1) {
    return { row: liveBySourceId.get(id)[0], method: "source_record_id" };
  }

  const key = `${invoiceNumber(source) ?? ""}|${itemCode(source) ?? ""}`;
  const candidates = liveByInvoiceItem.get(key) ?? [];
  if (candidates.length === 1) return { row: candidates[0], method: "invoice_item" };
  if (candidates.length > 1) return { row: null, method: "ambiguous_invoice_item", candidates };
  return { row: null, method: "none" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir });
  const supabase = createSupabaseAdminClient();

  const [liveLines, historyRows] = await Promise.all([
    loadAll(supabase, "shipping_order_lines", "id, source_record_id, source_key, legacy_item_code, legacy_matched_item_code, ordered_qty, approved_qty, fulfilled_qty, priority, approval_status, warehouse_status, fulfillment_status, shipping_orders(order_number, legacy_customer_name, review_status)"),
    loadAll(supabase, "old_erp_order_status_history", "source_record_id, invoice_number, customer_name, item_code, quantity, historical_status, occurred_at"),
  ]);

  const liveBySourceId = buildIndex(liveLines, (row) => normalizeText(row.source_record_id));
  const liveByInvoiceItem = buildIndex(liveLines, (row) => `${normalizeText(row.shipping_orders?.order_number) ?? ""}|${normalizeSku(row.legacy_matched_item_code ?? row.legacy_item_code) ?? ""}`);
  const historyBySourceId = buildIndex(historyRows, (row) => normalizeText(row.source_record_id));

  const counts = {};
  const rows = [];
  const sourceDuplicateIds = [];

  for (const source of sources.invoiceQueueItems) {
    const id = sourceId(source);
    if (!id) continue;
    const historyMatches = historyBySourceId.get(id) ?? [];
    const liveMatch = matchLive(source, liveBySourceId, liveByInvoiceItem);
    const isExpectedLive = expectedLive(source);
    const status = classifyHistoricalStatus(source);
    const sourceHistory = historyMatches.length === 1;
    const liveExists = Boolean(liveMatch.row);
    const liveAmbiguous = liveMatch.method === "ambiguous_invoice_item";
    const mismatches = liveExists ? compareFields(source, liveMatch.row) : [];

    let classification = "SOURCE_ONLY";
    if (historyMatches.length > 1) classification = "DUPLICATE_SOURCE_ID";
    else if (isExpectedLive && liveAmbiguous) classification = "AMBIGUOUS_MATCH";
    else if (isExpectedLive && liveExists && sourceHistory && mismatches.length > 0) classification = "FIELD_MISMATCH";
    else if (isExpectedLive && liveExists && sourceHistory) classification = "MATCHED_ALL_THREE";
    else if (isExpectedLive && liveExists && !sourceHistory) classification = "MATCHED_SOURCE_LIVE_MISSING_HISTORY";
    else if (isExpectedLive && sourceHistory && !liveExists) classification = "MATCHED_SOURCE_HISTORY_MISSING_LIVE";
    else if (!isExpectedLive && sourceHistory) classification = "EXPECTED_NOT_LIVE";
    else if (!isExpectedLive && liveExists) classification = "LIVE_ONLY";

    counts[classification] = (counts[classification] ?? 0) + 1;
    if (historyMatches.length > 1) sourceDuplicateIds.push(id);
    if (classification !== "MATCHED_ALL_THREE" && classification !== "EXPECTED_NOT_LIVE") {
      rows.push({
        classification,
        sourceRecordId: id,
        invoiceNumber: invoiceNumber(source),
        customerName: normalizeText(source.customerName),
        itemCode: itemCode(source),
        quantity: queueRecordQty(source),
        historicalStatus: status,
        expectedLive: isExpectedLive,
        historyMatches: historyMatches.length,
        liveMatchMethod: liveMatch.method,
        liveLineId: liveMatch.row?.id ?? null,
        fieldMismatches: mismatches,
      });
    }
  }

  for (const live of liveLines) {
    const sourceIdValue = normalizeText(live.source_record_id);
    if (sourceIdValue && sources.invoiceQueueItems.some((source) => sourceId(source) === sourceIdValue)) continue;
    const key = `${normalizeText(live.shipping_orders?.order_number) ?? ""}|${normalizeSku(live.legacy_matched_item_code ?? live.legacy_item_code) ?? ""}`;
    const sourceCandidates = sources.invoiceQueueItems.filter((source) => `${invoiceNumber(source) ?? ""}|${itemCode(source) ?? ""}` === key);
    if (sourceCandidates.length === 0) {
      counts.LIVE_ONLY = (counts.LIVE_ONLY ?? 0) + 1;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    sourceFiles: sources.files,
    sourceCount: sources.invoiceQueueItems.length,
    historyCount: historyRows.length,
    liveLineCount: liveLines.length,
    counts,
    sourceDuplicateIds,
    exceptions: rows.slice(0, 1000),
    notes: [
      "Terminal OLD_ERP statuses are expected to be history-only and are not counted as missing live orders.",
      "Accepted and in-warehouse rows are expected to match live shipping lines.",
      "No Supabase writes were performed.",
    ],
  };

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-order-parity-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Order Parity Report ===\n");
  console.log({ sourceCount: report.sourceCount, historyCount: report.historyCount, liveLineCount: report.liveLineCount, counts: report.counts });
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown order parity failure"));
