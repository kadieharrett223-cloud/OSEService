#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const normalize = value => String(value ?? "").trim().toUpperCase();
const remaining = row => Math.max(0, Number(row.approved_qty ?? row.ordered_qty ?? 0) - Number(row.fulfilled_qty ?? 0));
const heldSkus = new Set(["HLCJ-6", "JVCJ-6", "000185", "10000006", "HPU1103", "2PCFHD-12"]);
const heldInvoice = "126037";
const priorityRank = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const [{ data: lines, error: lineError }, { data: queue, error: queueError }] = await Promise.all([
  db.from("shipping_order_lines").select("id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,priority,queue_position_start,queue_position_count,queue_position_override,queue_position_override_reason,created_at,products(sku),shipping_orders(order_number,source_system,created_at,customers(company_name,full_name))"),
  db.from("manual_product_mapping_queue").select("source_sku,status"),
]);
if (lineError) throw new Error(lineError.message);
if (queueError) throw new Error(queueError.message);
const manualSkus = new Set((queue ?? []).filter(row => row.status === "OPEN").map(row => normalize(row.source_sku)));
const excluded = row => manualSkus.has(normalize(row.products?.sku)) || normalize(row.shipping_orders?.order_number) === heldInvoice || normalize(row.fulfillment_status) === "FULFILLED" || ["CANCELLED", "REMOVED", "DENIED"].includes(normalize(row.fulfillment_status)) || !["APPROVED", "PARTIAL"].includes(normalize(row.approval_status)) || !row.product_id || remaining(row) <= 0;
const active = (lines ?? []).filter(row => !excluded(row));
const byProduct = new Map();
for (const line of active) byProduct.set(line.product_id, [...(byProduct.get(line.product_id) ?? []), line]);
const updates = [];
for (const [productId, productLines] of byProduct.entries()) {
  const sorted = [...productLines].sort((left, right) => {
    const leftOverride = Number(left.queue_position_override);
    const rightOverride = Number(right.queue_position_override);
    const hasLeft = Number.isFinite(leftOverride) && leftOverride > 0;
    const hasRight = Number.isFinite(rightOverride) && rightOverride > 0;
    if (hasLeft || hasRight) { if (!hasLeft) return 1; if (!hasRight) return -1; if (leftOverride !== rightOverride) return leftOverride - rightOverride; }
    const priority = (priorityRank[normalize(left.priority)] ?? 2) - (priorityRank[normalize(right.priority)] ?? 2);
    if (priority !== 0) return priority;
    const created = String(left.shipping_orders?.created_at ?? left.created_at ?? "").localeCompare(String(right.shipping_orders?.created_at ?? right.created_at ?? ""));
    return created || left.id.localeCompare(right.id);
  });
  let position = 1;
  for (const line of sorted) {
    const units = remaining(line);
    updates.push({ productId, lineId: line.id, invoice: line.shipping_orders?.order_number ?? null, customer: line.shipping_orders?.customers?.company_name ?? line.shipping_orders?.customers?.full_name ?? null, sku: line.products?.sku ?? null, currentStart: line.queue_position_start, nextStart: position, count: units, needsUpdate: line.queue_position_start !== position || line.queue_position_count !== units });
    position += units;
  }
}
const toUpdate = updates.filter(row => row.needsUpdate);
console.log(JSON.stringify({ apply: APPLY, openManualExceptions: manualSkus.size, activeMappedLines: active.length, activeMappedLinesWithPositions: active.filter(row => row.queue_position_start !== null && row.queue_position_count !== null).length, activeMappedLinesMissingPositions: active.filter(row => row.queue_position_start === null || row.queue_position_count === null).length, productCount: byProduct.size, updates: toUpdate.length }, null, 2));
if (!APPLY) process.exit(0);
let succeeded = 0;
const failed = [];
for (const update of toUpdate) {
  const result = await db.from("shipping_order_lines").update({ queue_position_start: update.nextStart, queue_position_count: update.count }).eq("id", update.lineId).eq("product_id", update.productId);
  if (result.error) failed.push({ ...update, error: result.error.message }); else succeeded += 1;
}
const { data: after, error: afterError } = await db.from("shipping_order_lines").select("id,product_id,approved_qty,ordered_qty,fulfilled_qty,approval_status,fulfillment_status,queue_position_start,queue_position_count,products(sku),shipping_orders(order_number)");
if (afterError) throw new Error(afterError.message);
const afterActive = (after ?? []).filter(row => !excluded(row));
const starts = new Map();
for (const row of afterActive) { const key = `${row.product_id}|${row.queue_position_start}`; starts.set(key, (starts.get(key) ?? 0) + 1); }
const duplicatePositions = [...starts.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
const { count: exceptionCount, error: exceptionError } = await db.from("manual_product_mapping_queue").select("id", { count: "exact", head: true }).eq("status", "OPEN");
if (exceptionError) throw new Error(exceptionError.message);
const validation = { updatesAttempted: toUpdate.length, updatesSucceeded: succeeded, updatesFailed: failed.length, failed, activeMappedLines: afterActive.length, activeMappedLinesWithPositions: afterActive.filter(row => row.queue_position_start !== null && row.queue_position_count !== null).length, activeMappedLinesMissingPositions: afterActive.filter(row => row.queue_position_start === null || row.queue_position_count === null).length, duplicateQueuePositions: duplicatePositions.length, manualExceptionsRemaining: exceptionCount ?? 0, invoice126037Excluded: true, inventoryChanged: false, productsRebuilt: byProduct.size };
fs.writeFileSync("tmp/import-reports/active-order-queue-repair-validation.json", JSON.stringify(validation, null, 2));
console.log(JSON.stringify(validation, null, 2));
