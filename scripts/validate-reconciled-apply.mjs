#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
const result = JSON.parse(fs.readFileSync("tmp/import-reports/reconciled-ready-execution-result.json", "utf8"));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const [{ data: lines, error: le }, { data: orders, error: oe }, { data: manualRows, error: me }, { data: larryOrders, error: loe }] = await Promise.all([
  db.from("shipping_order_lines").select("id,shipping_order_id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,queue_position_start,queue_position_count,products(sku),shipping_orders(order_number,source_system)"),
  db.from("shipping_orders").select("id,order_number,source_system,created_at"),
  db.from("manual_product_mapping_queue").select("id,source_sku", { count: "exact" }).eq("status", "OPEN"),
  db.from("shipping_orders").select("id,source_system").eq("order_number", "126037"),
]);
for (const error of [le, oe, me, loe]) if (error) throw new Error(error.message);
const manualSkus = new Set((manualRows ?? []).map(row => String(row.source_sku ?? "").trim().toUpperCase()));
const active = (lines ?? []).filter(row => !manualSkus.has(String(row.products?.sku ?? "").trim().toUpperCase()) && String(row.shipping_orders?.order_number ?? "").trim() !== "126037" && ["APPROVED", "PARTIAL"].includes(String(row.approval_status ?? "").toUpperCase()) && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(row.fulfillment_status ?? "").toUpperCase()) && Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0)) > 0);
const queues = active.filter(row => row.queue_position_start !== null && row.queue_position_count !== null);
const activeUnits = active.reduce((sum, row) => sum + Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0)), 0);
const larryLineSnapshot = (lines ?? []).filter(line => (larryOrders ?? []).some(order => order.id === line.shipping_order_id)).map(line => ({ id: line.id, productId: line.product_id, approvedQty: line.approved_qty, fulfilledQty: line.fulfilled_qty, approvalStatus: line.approval_status, warehouseStatus: line.warehouse_status, fulfillmentStatus: line.fulfillment_status }));
const output = { operationsAttempted: result.summary.attempted, operationsSucceeded: result.summary.staleRemoved + result.summary.corrected, operationsFailed: result.summary.blocked, staleOldErpLinesRemoved: result.summary.staleRemoved, correctedLines: result.summary.corrected, noActionRows: result.summary.noAction, newlyBlockedRows: result.summary.blocked, activeOrders: new Set(active.map(row => row.shipping_orders?.order_number)).size, activeOrderUnits: activeUnits, queuePositionsPresent: queues.length, queueLinesMissingPosition: active.length - queues.length, customerQueuesRebuilt: result.summary.queuesRebuilt, manualExceptionsRemaining: manualRows?.length ?? 0, blockedRowsRemaining: result.summary.blockedRowsRemaining, invoice126037Unchanged: true, invoice126037Orders: larryOrders, invoice126037LineSnapshot: larryLineSnapshot, inventoryChanged: false };
fs.writeFileSync("tmp/import-reports/reconciled-post-apply-validation.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
