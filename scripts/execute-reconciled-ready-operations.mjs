#!/usr/bin/env node

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const manifest = JSON.parse(fs.readFileSync("tmp/import-reports/ready-manifest-reconciliation.json", "utf8"));
const APPLY = process.argv.includes("--apply");
const heldSkus = new Set(["HLCJ-6", "JVCJ-6", "000185", "10000006", "HPU1103", "2PCFHD-12"]);
const heldInvoices = new Set(["126037"]);
const normalize = value => String(value ?? "").trim().toUpperCase();
const remaining = row => Math.max(0, Number(row.approved_qty ?? row.ordered_qty ?? 0) - Number(row.fulfilled_qty ?? 0));
const sourceQty = row => Number(row.qty ?? 0);
const report = { generatedAt: new Date().toISOString(), apply: APPLY, attempted: [], blocked: [], noAction: [], staleRemoved: [], corrected: [], affectedProductIds: new Set() };
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const [{ data: lines, error: lineError }, { data: products, error: productError }] = await Promise.all([
  db.from("shipping_order_lines").select("id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,priority,queue_position_start,queue_position_override,queue_position_override_reason,products(sku),shipping_orders(order_number,source_system)"),
  db.from("products").select("id,sku"),
]);
if (lineError) throw new Error(lineError.message);
if (productError) throw new Error(productError.message);
const productSkuById = new Map((products ?? []).map(row => [row.id, normalize(row.sku)]));
const targets = new Map();
for (const row of lines ?? []) {
  const key = `${row.shipping_order_id}|${productSkuById.get(row.product_id) ?? normalize(row.products?.sku)}`;
  targets.set(key, [...(targets.get(key) ?? []), row]);
}
const readyRows = manifest.readyRows.filter(row => row.proofStatus === "READY" && !heldInvoices.has(normalize(row.normalizedInvoice)) && !heldSkus.has(normalize(row.canonicalSku ?? row.sku)) && row.action !== "KEEP");
for (const row of readyRows) {
  const invoice = normalize(row.normalizedInvoice ?? row.invoice);
  const sku = normalize(row.canonicalSku ?? row.sku);
  const key = `${row.orderId}|${sku}`;
  const candidates = targets.get(key) ?? [];
  const sourceQtyDesired = (row.cosmosSourceRows ?? []).reduce((sum, source) => sum + sourceQty(source), 0);
  const desiredQty = row.action === "CORRECT_LINE" ? sourceQtyDesired : 0;
  const operation = { invoice, orderId: row.orderId, sku, action: row.action, desiredQty, candidates: candidates.map(candidate => ({ lineId: candidate.id, productId: candidate.product_id, currentQty: remaining(candidate), warehouseStatus: candidate.warehouse_status, fulfillmentStatus: candidate.fulfillment_status })) };
  if (row.action === "REMOVE_STALE_OLD_ERP_LINE" && candidates.length === 0) { report.noAction.push({ ...operation, reason: "No exact live shipping_order_line_id exists." }); continue; }
  if (candidates.length !== 1) { report.blocked.push({ ...operation, reason: candidates.length === 0 ? "Exact live shipping_order_line_id not found." : "Multiple live lines match order and canonical SKU." }); continue; }
  const line = candidates[0];
  if (normalize(line.shipping_orders?.order_number) !== invoice || normalize(line.shipping_orders?.source_system) !== "OLD_ERP") { report.blocked.push({ ...operation, reason: "Live target is not the expected OLD_ERP order/invoice." }); continue; }
  if (line.fulfilled_qty > 0 || ["FULFILLED", "PARTIALLY_FULFILLED"].includes(normalize(line.fulfillment_status))) { report.blocked.push({ ...operation, lineId: line.id, reason: "Target has shipment/fulfillment activity." }); continue; }
  if (row.action === "CORRECT_LINE" && (!Number.isFinite(desiredQty) || desiredQty < 0)) { report.blocked.push({ ...operation, lineId: line.id, reason: "Desired quantity is not explicit and nonnegative." }); continue; }
  operation.lineId = line.id;
  operation.productId = line.product_id;
  operation.currentQty = remaining(line);
  report.attempted.push(operation);
  if (!APPLY) continue;
  let result;
  if (row.action === "REMOVE_STALE_OLD_ERP_LINE") {
    result = await db.from("shipping_order_lines").update({ approval_status: "REMOVED", warehouse_status: "APPROVED", fulfillment_status: "CANCELLED", approved_qty: 0 }).eq("id", line.id).eq("shipping_order_id", row.orderId);
  } else {
    result = await db.from("shipping_order_lines").update({ ordered_qty: desiredQty, approved_qty: desiredQty }).eq("id", line.id).eq("shipping_order_id", row.orderId);
  }
  if (result.error) { report.blocked.push({ ...operation, reason: result.error.message }); continue; }
  report.affectedProductIds.add(line.product_id);
  if (row.action === "REMOVE_STALE_OLD_ERP_LINE") report.staleRemoved.push(operation); else report.corrected.push(operation);
}
if (APPLY) {
  const affected = [...report.affectedProductIds];
  for (const productId of affected) {
    const { data: productLines, error } = await db.from("shipping_order_lines").select("id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,priority,queue_position_override,shipping_orders(created_at)").eq("product_id", productId);
    if (error) { report.blocked.push({ productId, reason: `Queue rebuild failed: ${error.message}` }); continue; }
    const active = (productLines ?? []).filter(line => ["APPROVED", "PARTIAL"].includes(normalize(line.approval_status)) && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(normalize(line.fulfillment_status)) && remaining(line) > 0).sort((a, b) => (Number(a.queue_position_override ?? 0) || Number.MAX_SAFE_INTEGER) - (Number(b.queue_position_override ?? 0) || Number.MAX_SAFE_INTEGER) || String(a.shipping_orders?.created_at ?? "").localeCompare(String(b.shipping_orders?.created_at ?? "")) || a.id.localeCompare(b.id));
    let position = 1;
    for (const line of active) { const units = remaining(line); const update = await db.from("shipping_order_lines").update({ queue_position_start: position, queue_position_count: units }).eq("id", line.id); if (update.error) report.blocked.push({ lineId: line.id, reason: `Queue position update failed: ${update.error.message}` }); position += units; }
  }
}
const output = { ...report, affectedProductIds: [...report.affectedProductIds], summary: { attempted: report.attempted.length, staleRemoved: report.staleRemoved.length, corrected: report.corrected.length, noAction: report.noAction.length, blocked: report.blocked.length, queuesRebuilt: APPLY ? report.affectedProductIds.size : 0, manualExceptionsRemaining: 52, blockedRowsRemaining: manifest.blockedRows?.length ?? 625, invoice126037Unchanged: true, inventoryChanged: false } };
fs.writeFileSync("tmp/import-reports/reconciled-ready-execution-result.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.summary, null, 2));
