#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

function readRunId(argv) {
  const index = argv.indexOf("--run");
  return index >= 0 ? String(argv[index + 1] ?? "").trim() : "";
}

function normalized(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isActiveDemand(line) {
  return ["APPROVED", "PARTIAL"].includes(normalized(line.approval_status))
    && !["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"].includes(normalized(line.fulfillment_status))
    && Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0)
    && !line.shipping_orders?.duplicate_of_order_id;
}

async function loadAll(supabase, table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function main() {
  const runId = readRunId(process.argv.slice(2));
  if (!runId) throw new Error("Usage: npm run report:qbo-backlog-import -- --run <run-id>");

  const supabase = createSupabaseAdminClient();
  const [auditRows, orderLines, transactions] = await Promise.all([
    loadAll(supabase, "audit_log", "action,details"),
    loadAll(supabase, "shipping_order_lines", "qbo_invoice_line_id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,queue_position_start,queue_position_count,shipping_orders(duplicate_of_order_id),products(sku)"),
    loadAll(supabase, "inventory_transactions", "product_id,bucket,delta"),
  ]);
  const detailsForRun = auditRows
    .map((row) => ({ action: row.action, details: row.details ?? {} }))
    .filter((row) => row.details?.run_id === runId);
  const classifications = detailsForRun.filter((row) => row.action === "QBO_BACKLOG_CLASSIFIED").map((row) => row.details);
  const snapshots = new Map(detailsForRun
    .filter((row) => row.action === "QBO_BACKLOG_PRODUCT_SNAPSHOT")
    .map((row) => [row.details.product_id, row.details]));
  if (!classifications.length) throw new Error(`No QBO backlog classification audit rows found for run ${runId}.`);

  const orderLineByQboLineId = new Map(orderLines.filter((line) => line.qbo_invoice_line_id).map((line) => [line.qbo_invoice_line_id, line]));
  const affectedProductIds = new Set([...snapshots.keys()]);
  const onFloorByProduct = new Map();
  for (const transaction of transactions) {
    if (normalized(transaction.bucket) !== "ON_FLOOR" || !affectedProductIds.has(transaction.product_id)) continue;
    onFloorByProduct.set(transaction.product_id, (onFloorByProduct.get(transaction.product_id) ?? 0) + Number(transaction.delta ?? 0));
  }
  const soldByProduct = new Map();
  for (const line of orderLines) {
    if (!affectedProductIds.has(line.product_id) || !isActiveDemand(line)) continue;
    soldByProduct.set(line.product_id, (soldByProduct.get(line.product_id) ?? 0) + Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
  }

  const lines = classifications.map((row) => {
    const orderLine = orderLineByQboLineId.get(row.qbo_invoice_line_id);
    const position = orderLine?.queue_position_start
      ? `#${orderLine.queue_position_start}${Number(orderLine.queue_position_count ?? 0) > 1 ? `-${Number(orderLine.queue_position_start) + Number(orderLine.queue_position_count) - 1}` : ""}`
      : null;
    return {
      "Invoice #": row.invoice_number ?? null,
      Customer: row.customer_name ?? null,
      "First Paid": row.first_payment_at ?? null,
      SKU: row.qbo_sku ?? null,
      Qty: Number(row.quantity ?? 0),
      Decision: row.decision,
      "Customer List Position": position,
    };
  }).sort((left, right) => String(left["First Paid"]).localeCompare(String(right["First Paid"])) || String(left["Invoice #"]).localeCompare(String(right["Invoice #"])));
  const skus = [...affectedProductIds].map((productId) => {
    const snapshot = snapshots.get(productId);
    const exampleLine = orderLines.find((line) => line.product_id === productId);
    const onFloorBefore = Number(snapshot?.on_floor_before ?? 0);
    const onFloorAfter = Number(onFloorByProduct.get(productId) ?? 0);
    const soldBefore = Number(snapshot?.sold_before ?? 0);
    const soldAfter = Number(soldByProduct.get(productId) ?? 0);
    return {
      SKU: exampleLine?.products?.sku ?? productId,
      "ON_FLOOR Before": onFloorBefore,
      "ON_FLOOR After": onFloorAfter,
      "Sold Before": soldBefore,
      "Sold After": soldAfter,
      "Available Before": onFloorBefore - soldBefore,
      "Available After": onFloorAfter - soldAfter,
      "Customer List Qty": soldAfter,
      onFloorConserved: onFloorBefore === onFloorAfter,
      customerListMatchesSold: soldAfter === Number(soldByProduct.get(productId) ?? 0),
    };
  }).sort((left, right) => String(left.SKU).localeCompare(String(right.SKU)));
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READ_ONLY_POST_IMPORT_RECONCILIATION",
    runId,
    summary: {
      imported: lines.filter((line) => line.Decision === "IMPORTED").length,
      alreadyPresent: lines.filter((line) => line.Decision === "ALREADY PRESENT — SKIPPED").length,
      closed: lines.filter((line) => line.Decision === "CLOSED — SKIPPED").length,
      manualDuplicateReview: lines.filter((line) => line.Decision === "MANUAL DUPLICATE — REVIEW").length,
      unmappedReview: lines.filter((line) => line.Decision === "UNMAPPED — REVIEW").length,
      onFloorConserved: skus.every((sku) => sku.onFloorConserved),
      customerListsMatchSold: skus.every((sku) => sku.customerListMatchesSold),
    },
    lines,
    skus,
  };
  const reportPath = writeJsonFile(path.resolve(`tmp/import-reports/qbo-backlog-import-run-${runId}-${timestampSlug()}.json`), report);
  console.log("\n=== QBO Backlog Import Reconciliation ===\n");
  console.log(report.summary);
  console.table(lines);
  console.table(skus);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown QBO backlog reconciliation failure"));