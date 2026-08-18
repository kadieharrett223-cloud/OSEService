#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
if (!APPLY) throw new Error("Run with --apply to execute targeted fulfillment reconstruction.");
const source = JSON.parse(fs.readFileSync("tmp/exports/azure-InvoiceQueueItems-2026-08-14T17-02-42-562Z.json", "utf8"));
const rawRows = Array.isArray(source) ? source : source.records ?? source.items ?? source.data ?? [];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const n = value => String(value ?? "").trim().toUpperCase();
const invoiceOf = row => { const raw = String(row.invoiceNumber ?? row.invoice_number ?? row.orderNumber ?? row.qbo_invoices?.invoice_number ?? "").trim(); if (!raw) return null; const number = Number(raw); return Number.isFinite(number) ? String(number) : n(raw); };
const skuOf = row => n(row.matchedItemCode ?? row.matched_item_code ?? row.matchedSku ?? row.itemCode ?? row.item_code ?? row.sku ?? row.partNumber ?? row.products?.sku);
const qtyOf = row => Number(row.qty ?? row.approvedQty ?? row.orderedQty ?? row.quantity ?? 0);
const remaining = row => Math.max(0, Number(row.approved_qty ?? row.ordered_qty ?? 0) - Number(row.fulfilled_qty ?? 0));
const heldSkus = new Set(["HLCJ-6", "JVCJ-6", "220V", "HPU2204", "4PHDXLA-14", "APU", "YZ-ARJT", "000185", "10000006", "HPU1103", "2PCFHD-12"]);
const heldInvoice = "126037";
const [{ data: orders, error: oe }, { data: lines, error: le }, { data: products, error: pe }, { data: aliases, error: ae }, { data: fulfillments, error: fe }, { data: manual, error: me }] = await Promise.all([
  db.from("shipping_orders").select("id,order_number,source_system,source_key,created_at,review_status,customers(company_name,full_name),qbo_invoices(invoice_number)"),
  db.from("shipping_order_lines").select("id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,priority,queue_position_start,queue_position_count,products(id,sku,canonical_name),shipping_orders(id,order_number,source_system,created_at)"),
  db.from("products").select("id,sku"),
  db.from("product_aliases").select("product_id,alias"),
  db.from("fulfillments").select("shipping_order_line_id,fulfilled_qty,fulfilled_at,shipment_number,tracking_number,reason"),
  db.from("manual_product_mapping_queue").select("source_sku,status").eq("status", "OPEN"),
]);
for (const error of [oe, le, pe, ae, fe, me]) if (error) throw new Error(error.message);
const held = new Set([...(manual ?? []).map(row => n(row.source_sku)), ...heldSkus]);
const productMap = new Map(); const add = (key, id) => { if (!key || !id) return; const set = productMap.get(key) ?? new Set(); set.add(id); productMap.set(key, set); };
for (const row of products ?? []) { add(n(row.sku), row.id); add(n(row.sku).replace(/[^A-Z0-9]/g, ""), row.id); }
for (const row of aliases ?? []) { add(n(row.alias), row.product_id); add(n(row.alias).replace(/[^A-Z0-9]/g, ""), row.product_id); }
const canonicalProduct = sku => { const set = productMap.get(n(sku)) ?? productMap.get(n(sku).replace(/[^A-Z0-9]/g, "")); return set?.size === 1 ? [...set][0] : null; };
const productSkuById = new Map((products ?? []).map(row => [row.id, n(row.sku)]));
const orderById = new Map((orders ?? []).map(row => [row.id, row]));
const fulfillmentByLine = new Map(); for (const row of fulfillments ?? []) fulfillmentByLine.set(row.shipping_order_line_id, [...(fulfillmentByLine.get(row.shipping_order_line_id) ?? []), row]);
const sourceEvidence = new Map();
for (const raw of rawRows) {
  const invoice = invoiceOf(raw); const sourceSku = skuOf(raw); if (!invoice || !sourceSku || heldInvoice === invoice || held.has(sourceSku)) continue;
  const productId = canonicalProduct(sourceSku); if (!productId) continue;
  const key = `${invoice}|${productId}`; const entry = sourceEvidence.get(key) ?? { invoice, productId, rows: [], provenShipped: 0, currentOpen: 0, ambiguous: false };
  const queue = n(raw.queueStatus ?? raw.queue_status ?? raw.status); const warehouse = n(raw.warehouseStatus ?? raw.warehouse_status); const fulfilledAt = raw.fulfilledAt ?? raw.fulfilled_at;
  entry.rows.push({ id: raw.id ?? raw._id ?? raw.recordId ?? null, sourceSku, qty: qtyOf(raw), approvalStatus: raw.approvalStatus, queueStatus: queue, warehouseStatus: warehouse, fulfilledAt: fulfilledAt ?? null, removed: raw.removed ?? false });
  if (fulfilledAt || queue === "FULFILLED" || warehouse === "SHIPPED") entry.provenShipped = Math.max(entry.provenShipped, qtyOf(raw));
  if (!fulfilledAt && queue !== "FULFILLED" && warehouse !== "SHIPPED" && !["REMOVED", "DENIED", "CANCELLED", "CANCELED"].includes(queue) && n(raw.approvalStatus) === "APPROVED") entry.currentOpen += qtyOf(raw);
  sourceEvidence.set(key, entry);
}
const targetLines = (lines ?? []).filter(line => {
  const order = orderById.get(line.shipping_order_id) ?? line.shipping_orders;
  const invoice = invoiceOf(order); const sku = productSkuById.get(line.product_id) ?? n(line.products?.sku);
  return n(order?.source_system) === "OLD_ERP" && invoice !== heldInvoice && !held.has(sku) && line.product_id && remaining(line) > 0 && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(n(line.fulfillment_status));
});
const result = { ordersChecked: new Set(targetLines.map(row => row.shipping_order_id)).size, ordersChangedPartiallyShipped: 0, ordersChangedArchived: 0, fullyShippedLines: 0, partiallyShippedLines: 0, remainingUnits: 0, fulfillmentReviewLines: [], queuePositionsRemovedBecauseShipped: 0, queuePositionsRetainedBecauseOwed: 0, changedLines: [], errors: [], affectedProducts: new Set() };
const changedOrders = new Set();
for (const line of targetLines) {
  const order = orderById.get(line.shipping_order_id); const invoice = invoiceOf(order); const sku = productSkuById.get(line.product_id) ?? n(line.products?.sku); const evidence = sourceEvidence.get(`${invoice}|${line.product_id}`); const existingShipped = Math.max(Number(line.fulfilled_qty ?? 0), (fulfillmentByLine.get(line.id) ?? []).reduce((sum, row) => sum + Number(row.fulfilled_qty ?? 0), 0)); const provenShipped = Math.max(existingShipped, evidence?.provenShipped ?? 0); const ordered = Number(line.approved_qty ?? line.ordered_qty ?? 0); const desiredFulfilled = Math.min(ordered, provenShipped);
  if (!evidence) { result.fulfillmentReviewLines.push({ invoice, lineId: line.id, sku, reason: "No deterministic historical Cosmos SKU evidence" }); result.remainingUnits += remaining(line); result.queuePositionsRetainedBecauseOwed += 1; continue; }
  if (desiredFulfilled <= Number(line.fulfilled_qty ?? 0)) { result.remainingUnits += remaining(line); if (remaining(line) > 0) result.queuePositionsRetainedBecauseOwed += 1; continue; }
  const desiredRemaining = Math.max(0, ordered - desiredFulfilled); const nextFulfillment = desiredRemaining === 0 ? "FULFILLED" : "PARTIALLY_FULFILLED"; const nextWarehouse = desiredRemaining === 0 ? "FULFILLED" : line.warehouse_status;
  const update = await db.from("shipping_order_lines").update({ fulfilled_qty: desiredFulfilled, fulfillment_status: nextFulfillment, warehouse_status: nextWarehouse }).eq("id", line.id).eq("shipping_order_id", line.shipping_order_id);
  if (update.error) { result.errors.push({ invoice, lineId: line.id, error: update.error.message }); continue; }
  result.changedLines.push({ invoice, lineId: line.id, sku, ordered, beforeFulfilled: line.fulfilled_qty, afterFulfilled: desiredFulfilled, remaining: desiredRemaining, evidence: evidence.rows }); result.affectedProducts.add(line.product_id); changedOrders.add(line.shipping_order_id); if (desiredRemaining === 0) { result.fullyShippedLines += 1; result.queuePositionsRemovedBecauseShipped += 1; } else { result.partiallyShippedLines += 1; result.remainingUnits += desiredRemaining; result.queuePositionsRetainedBecauseOwed += 1; }
}
for (const productId of result.affectedProducts) {
  const { data: productLines, error } = await db.from("shipping_order_lines").select("id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,priority,queue_position_override,shipping_orders(created_at)").eq("product_id", productId); if (error) { result.errors.push({ productId, error: error.message }); continue; }
  const active = (productLines ?? []).filter(row => ["APPROVED", "PARTIAL"].includes(n(row.approval_status)) && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(n(row.fulfillment_status)) && remaining(row) > 0).sort((a,b) => Number(a.queue_position_override ?? 0)-Number(b.queue_position_override ?? 0)||String(a.shipping_orders?.created_at??"").localeCompare(String(b.shipping_orders?.created_at??""))||a.id.localeCompare(b.id)); let pos=1; for(const row of active){const units=remaining(row);const u=await db.from("shipping_order_lines").update({queue_position_start:pos,queue_position_count:units}).eq("id",row.id);if(u.error)result.errors.push({lineId:row.id,error:u.error.message});pos+=units;} const inactive=(productLines??[]).filter(row=>!active.includes(row)); for(const row of inactive) await db.from("shipping_order_lines").update({queue_position_start:null,queue_position_count:null}).eq("id",row.id);
}
for (const orderId of changedOrders) { const { data: orderLines, error } = await db.from("shipping_order_lines").select("approved_qty,fulfilled_qty,fulfillment_status").eq("shipping_order_id", orderId); if (error) { result.errors.push({ orderId, error: error.message }); continue; } const valid = orderLines ?? []; const allFulfilled = valid.length > 0 && valid.every(row => n(row.fulfillment_status) === "FULFILLED"); const anyShipped = valid.some(row => Number(row.fulfilled_qty ?? 0) > 0); const update = await db.from("shipping_orders").update({ review_status: allFulfilled ? "FULFILLED" : "APPROVED" }).eq("id", orderId); if (update.error) result.errors.push({ orderId, error: update.error.message }); if (allFulfilled) result.ordersChangedArchived += 1; else if (anyShipped) result.ordersChangedPartiallyShipped += 1; }
result.affectedProducts = [...result.affectedProducts]; fs.writeFileSync("tmp/import-reports/fulfillment-reconstruction-result.json", JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
