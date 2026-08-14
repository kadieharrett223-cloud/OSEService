#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeText,
  pickFirst,
  timestampSlug,
  toNumber,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const STATUS_NAMES = new Set(["ACCEPTED", "IN_WAREHOUSE", "SHIPPED", "DENIED", "CANCELLED", "REMOVED", "OTHER_CLOSED"]);

function parseArgs(argv) {
  const args = { exportsDir: "tmp/exports", apply: false, reportOut: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--exports-dir") { args.exportsDir = String(argv[i + 1] ?? "").trim() || args.exportsDir; i += 1; }
    if (token === "--apply") args.apply = true;
    if (token === "--report-out") { args.reportOut = String(argv[i + 1] ?? "").trim(); i += 1; }
  }
  return args;
}

function classify(record) {
  const approval = String(record?.approvalStatus ?? "").trim().toUpperCase();
  const queue = String(record?.queueStatus ?? "").trim().toUpperCase();
  const warehouse = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  const shipped = Boolean(record?.fulfilledAt || record?.shippedAt || warehouse === "SHIPPED" || warehouse === "FULFILLED" || queue === "FULFILLED");
  const completed = Boolean(record?.invoiceCompletedAt || shipped || queue === "FULFILLED" || warehouse === "COMPLETED");
  const denied = approval === "DENIED" || queue === "DENIED" || String(record?.denialReason ?? "").trim().length > 0;
  const removed = queue === "REMOVED" || Boolean(record?.removed || record?.removedAt || record?.removeReason);
  const cancelled = String(record?.removeReason ?? "").toLowerCase().includes("cancel") || queue === "CANCELLED";

  if (denied) return "DENIED";
  if (cancelled) return "CANCELLED";
  if (removed) return "REMOVED";
  if (completed) return "SHIPPED";
  if (["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED"].includes(warehouse)) return "IN_WAREHOUSE";
  if (approval === "APPROVED" || queue === "APPROVED" || warehouse === "APPROVED" || record?.approvedAt) return "ACCEPTED";
  return null;
}

function mapRows(records) {
  const rows = [];
  const counts = {};
  const skipped = [];

  for (const record of records) {
    const sourceId = normalizeText(record?.id ?? record?._id);
    const status = classify(record);
    if (!sourceId || !status || !STATUS_NAMES.has(status)) {
      skipped.push({ sourceId, reason: "NO_HISTORICAL_STATUS" });
      continue;
    }

    counts[status] = (counts[status] ?? 0) + 1;
    rows.push({
      source_system: "OLD_ERP_COSMOS",
      source_container: "InvoiceQueueItems",
      source_record_id: sourceId,
      source_key: `OLD_ERP_ORDER_HISTORY:${sourceId}`,
      invoice_number: normalizeText(record?.invoiceNumber),
      customer_name: normalizeText(record?.customerName),
      item_code: normalizeText(pickFirst(record, ["itemCode", "originalItemCode", "matchedItemCode"])),
      quantity: toNumber(pickFirst(record, ["qty", "approvedQty", "quantity"])),
      historical_status: status,
      approval_status: normalizeText(record?.approvalStatus),
      queue_status: normalizeText(record?.queueStatus),
      warehouse_status: normalizeText(record?.warehouseStatus),
      fulfillment_status: normalizeText(record?.fulfillmentStatus),
      payment_status: normalizeText(pickFirst(record, ["payStatus", "paymentStatus"])),
      occurred_at: record?.fulfilledAt ?? record?.invoiceCompletedAt ?? record?.approvedAt ?? record?.removedAt ?? record?.deniedAt ?? record?.updatedAt ?? record?.createdAt ?? null,
      notes: normalizeText(record?.notes) ?? normalizeText(record?.removeReason) ?? normalizeText(record?.denialReason),
      raw_payload: record,
    });
  }

  return { rows, counts, skipped };
}

async function applyRows(supabase, rows) {
  let count = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const batch = rows.slice(offset, offset + 250);
    const { error } = await supabase.from("old_erp_order_status_history").upsert(batch, { onConflict: "source_system,source_container,source_record_id" });
    if (error) fail(`Could not archive order-status batch at ${offset}: ${error.message}`);
    count += batch.length;
  }
  return { insertedOrUpdated: count };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir });
  const mapped = mapRows(sources.invoiceQueueItems);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFile: sources.files.InvoiceQueueItems,
    sourceRecordCount: sources.invoiceQueueItems.length,
    historicalRows: mapped.rows.length,
    statusCounts: mapped.counts,
    skippedRows: mapped.skipped.length,
    notes: [
      "Historical outcomes are archive-only and do not create live shipping demand.",
      "No inventory allocations or inventory transactions are created.",
      "The raw source payload is preserved for every imported status row.",
    ],
  };
  if (args.apply) {
    report.applyResults = await applyRows(createSupabaseAdminClient(), mapped.rows);
  }
  const reportPath = args.reportOut ? path.resolve(args.reportOut) : path.resolve(`tmp/import-reports/old-erp-order-status-history-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Historical Order Status Import ===\n");
  console.log(report);
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown historical order import failure"));
