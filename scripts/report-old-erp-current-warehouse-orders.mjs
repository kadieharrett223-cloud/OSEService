#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { findLatestExport, readJsonArray, normalizeSku, normalizeText, pickFirst, toNumber, timestampSlug, writeJsonFile } from "./old-erp-migration-utils.mjs";

function parseArgs(argv) {
  const args = { input: "", reportOut: "", csvOut: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") { args.input = String(argv[index + 1] ?? "").trim(); index += 1; }
    if (token === "--report-out") { args.reportOut = String(argv[index + 1] ?? "").trim(); index += 1; }
    if (token === "--csv-out") { args.csvOut = String(argv[index + 1] ?? "").trim(); index += 1; }
  }
  return args;
}

function value(record, keys) {
  return normalizeText(pickFirst(record, keys));
}

function quantity(record) {
  return Number(toNumber(pickFirst(record, ["qty", "approvedQty", "quantity", "orderedQty"])) ?? 0);
}

function isClosed(record) {
  const approval = String(record?.approvalStatus ?? "").trim().toUpperCase();
  const queue = String(record?.queueStatus ?? record?.status ?? "").trim().toUpperCase();
  const warehouse = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  return Boolean(record?.removed)
    || approval === "DENIED"
    || ["DENIED", "REMOVED", "CANCELLED", "FULFILLED"].includes(queue)
    || ["SHIPPED", "FULFILLED", "COMPLETED"].includes(warehouse)
    || Boolean(record?.fulfilledAt || record?.warehouseShippedAt);
}

function isApprovedOpen(record) {
  return String(record?.approvalStatus ?? "").trim().toUpperCase() === "APPROVED"
    && String(record?.queueStatus ?? "").trim().toUpperCase() === "APPROVED"
    && !isClosed(record)
    && quantity(record) > 0;
}

function warehouseSignal(record) {
  const warehouseStatus = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  const assignmentType = String(record?.floorAssignment?.type ?? "").trim().toLowerCase();
  if (warehouseStatus === "ACTIVE") return "warehouse_status_active";
  if (assignmentType === "floor") return "floor_assignment";
  return null;
}

function mapRow(record) {
  const assignment = record?.floorAssignment && typeof record.floorAssignment === "object" ? record.floorAssignment : {};
  const signal = warehouseSignal(record);
  return {
    source_record_id: value(record, ["id", "_id", "recordId", "lineId", "queueLineId"]),
    customer_name: value(record, ["customerName", "customer_name", "companyName", "customer"]),
    invoice_number: value(record, ["invoiceNumber", "invoice_number", "orderNumber"]),
    item_sku: normalizeSku(pickFirst(record, ["matchedItemCode", "matched_item_code", "matchedSku", "itemCode", "item_code", "originalItemCode", "sku"])),
    original_item_code: normalizeSku(pickFirst(record, ["originalItemCode", "original_item_code"])),
    description: value(record, ["qboItemName", "description", "itemDescription"]),
    quantity: quantity(record),
    approval_status: value(record, ["approvalStatus", "approval_status"]),
    queue_status: value(record, ["queueStatus", "queue_status", "status"]),
    warehouse_status: value(record, ["warehouseStatus", "warehouse_status"]),
    warehouse_signal: signal,
    floor_assignment_type: value(assignment, ["type", "sourceType"]),
    floor_assignment_container_id: value(assignment, ["containerId", "container_id"]),
    floor_assignment_container_label: value(assignment, ["containerLabel", "container_label"]),
    floor_assignment_at: value(assignment, ["assignedAt", "assigned_at"]),
    floor_assignment_by: value(assignment, ["assignedBy", "assigned_by"]),
    priority: value(record, ["priorityFlag", "priority", "priority_flag"]),
    notes: value(record, ["notes", "warehouseDispatchNote", "warehouseCompletionNote", "warehouseIncompleteMessage"]),
    customer_memo: value(record, ["qboCustomerMemo", "qbo_customer_memo"]),
    private_memo: value(record, ["qboPrivateNote", "qbo_private_note"]),
    fulfillment_method: value(record, ["fulfillmentMethod", "fulfillment_method"]),
    shipping_method: value(record, ["qboShippingMethod", "shippingMethod", "qbo_shipping_method"]),
    created_at: value(record, ["createdAt", "created_at"]),
    approved_at: value(record, ["approvedAt", "approved_at"]),
    warehouse_at: value(record, ["warehouseSentAt", "warehouse_sent_at", "warehouseStatusAt"]),
    updated_at: value(record, ["updatedAt", "updated_at"]),
    expected_by: value(record, ["expectedBy", "expected_by"]),
  };
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const columns = Object.keys(rows[0] ?? {});
  const content = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${content}\n`, "utf8");
  return resolved;
}

const args = parseArgs(process.argv.slice(2));
const input = path.resolve(args.input || findLatestExport("tmp/exports", "InvoiceQueueItems"));
const records = readJsonArray(input);
const currentWarehouse = records.filter(isApprovedOpen).filter((record) => warehouseSignal(record)).map(mapRow);
const ambiguous = records.filter(isApprovedOpen).filter((record) => !warehouseSignal(record)).map((record) => ({ ...mapRow(record), ambiguity: "Approved/open but no ACTIVE warehouseStatus or floor assignment signal" }));

const unitsBySku = {};
const customersBySku = {};
for (const row of currentWarehouse) {
  unitsBySku[row.item_sku] = (unitsBySku[row.item_sku] ?? 0) + row.quantity;
  customersBySku[row.item_sku] ??= [];
  customersBySku[row.item_sku].push({ customer_name: row.customer_name, invoice_number: row.invoice_number, quantity: row.quantity });
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: "read-only-cosmos-report",
  input,
  sourceRecordCount: records.length,
  warehouseRule: {
    included: "approvalStatus=APPROVED, queueStatus=APPROVED, positive qty, not closed, and warehouseStatus=ACTIVE or floorAssignment.type=floor",
    excluded: "shipped, fulfilled, completed, denied, cancelled, removed, invoice-completed, fulfilledAt, warehouseShippedAt",
  },
  totals: {
    totalOrders: new Set(currentWarehouse.map((row) => row.invoice_number).filter(Boolean)).size,
    totalLines: currentWarehouse.length,
    totalUnits: currentWarehouse.reduce((sum, row) => sum + row.quantity, 0),
    ambiguousRecords: ambiguous.length,
  },
  unitsBySku,
  customersOrdersBySku: customersBySku,
  records: currentWarehouse,
  ambiguousRecords: ambiguous,
};

const slug = timestampSlug();
const reportPath = path.resolve(args.reportOut || `tmp/import-reports/old-erp-current-warehouse-${slug}.json`);
const csvPath = writeCsv(args.csvOut || `tmp/import-reports/old-erp-current-warehouse-${slug}.csv`, currentWarehouse);
const resolvedReport = writeJsonFile(reportPath, report);
console.log("\n=== OLD_ERP Current Warehouse Orders Report ===\n");
console.log(report.totals);
console.log("Units by SKU:", unitsBySku);
console.log(`JSON: ${resolvedReport}`);
console.log(`CSV: ${csvPath}`);
