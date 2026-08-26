#!/usr/bin/env node

import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const INVOICE_NUMBER = "127052";
const apply = process.argv.includes("--apply");

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase credentials. Run with node --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const number = (value) => Number(value ?? 0);

const { data: orders, error: orderError } = await db
  .from("shipping_orders")
  .select("id,order_number")
  .eq("order_number", INVOICE_NUMBER)
  .is("duplicate_of_order_id", null);
if (orderError) throw orderError;
if ((orders ?? []).length !== 1) throw new Error(`Expected one canonical parent for invoice ${INVOICE_NUMBER}; found ${(orders ?? []).length}.`);

const { data: lines, error: lineError } = await db
  .from("shipping_order_lines")
  .select("id,product_id,ordered_qty,approved_qty,fulfilled_qty,fulfillment_status,products(sku)")
  .eq("shipping_order_id", orders[0].id);
if (lineError) throw lineError;
if ((lines ?? []).length !== 1 || !lines[0].product_id) throw new Error(`Invoice ${INVOICE_NUMBER} must have exactly one mapped line.`);

const line = lines[0];
const demand = Math.max(number(line.ordered_qty), number(line.approved_qty));
if (demand !== 1 || number(line.fulfilled_qty) !== 1 || String(line.fulfillment_status ?? "").toUpperCase() !== "FULFILLED") {
  throw new Error(`Invoice ${INVOICE_NUMBER} is not the verified one-unit fulfilled test line.`);
}

const { data: shipments, error: shipmentError } = await db
  .from("order_shipments")
  .select("id,order_shipment_lines(shipping_order_line_id,quantity)")
  .eq("shipping_order_id", orders[0].id);
if (shipmentError) throw shipmentError;
const matchingShipmentLines = (shipments ?? []).flatMap((shipment) => (shipment.order_shipment_lines ?? [])
  .filter((shipmentLine) => shipmentLine.shipping_order_line_id === line.id)
  .map((shipmentLine) => ({ shipmentId: shipment.id, quantity: number(shipmentLine.quantity) })));
if (matchingShipmentLines.length !== 1 || matchingShipmentLines[0].quantity !== 1) {
  throw new Error(`Invoice ${INVOICE_NUMBER} must have exactly one one-unit shipment line.`);
}

const shipmentId = matchingShipmentLines[0].shipmentId;
const fulfillmentKey = `ORDER_SHIPMENT:${shipmentId}:${line.id}:ON_FLOOR`;
const reversalKey = `TEST_SHIPMENT_REVERSAL:${INVOICE_NUMBER}:${shipmentId}:${line.id}:ON_FLOOR`;
const [{ data: floorTransactions, error: floorError }, { data: reversal, error: reversalError }] = await Promise.all([
  db.from("inventory_transactions").select("id,delta,before_qty,after_qty,source_event_key").eq("product_id", line.product_id).eq("bucket", "ON_FLOOR").order("created_at"),
  db.from("inventory_transactions").select("id,delta,before_qty,after_qty,source_event_key").eq("source_event_key", reversalKey).maybeSingle(),
]);
if (floorError) throw floorError;
if (reversalError) throw reversalError;

const fulfillmentEvents = (floorTransactions ?? []).filter((transaction) => transaction.source_event_key === fulfillmentKey);
if (fulfillmentEvents.length !== 1 || number(fulfillmentEvents[0].delta) !== -1 || number(fulfillmentEvents[0].before_qty) !== 26 || number(fulfillmentEvents[0].after_qty) !== 25) {
  throw new Error("The expected test-shipment inventory decrement no longer reconciles exactly; no correction was written.");
}

const currentOnFloor = (floorTransactions ?? []).reduce((sum, transaction) => sum + number(transaction.delta), 0);
const report = {
  invoiceNumber: INVOICE_NUMBER,
  mode: apply ? "apply" : "preview",
  productSku: line.products?.sku ?? null,
  orderLineId: line.id,
  shipmentId,
  fulfillmentEventKey: fulfillmentKey,
  reversalEventKey: reversalKey,
  currentOnFloor,
  targetOnFloor: 26,
  existingReversal: reversal ?? null,
};

if (reversal) {
  console.log(JSON.stringify({ ...report, applied: false, idempotent: true, finalOnFloor: currentOnFloor }, null, 2));
  process.exit(0);
}
if (currentOnFloor !== 25) throw new Error(`Current ON_FLOOR is ${currentOnFloor}, not the verified post-test value 25; no correction was written.`);
if (!apply) {
  console.log(JSON.stringify({ ...report, applied: false, idempotent: false, plannedDelta: 1 }, null, 2));
  process.exit(0);
}

const { error: insertError } = await db.from("inventory_transactions").insert({
  product_id: line.product_id,
  bucket: "ON_FLOOR",
  delta: 1,
  before_qty: currentOnFloor,
  after_qty: 26,
  reason: `Controlled test inventory restoration for QBO invoice ${INVOICE_NUMBER}; shipment history remains fulfilled.`,
  source_type: "ADJUSTMENT",
  source_event_key: reversalKey,
  shipping_order_line_id: line.id,
});
if (insertError) throw insertError;

console.log(JSON.stringify({ ...report, applied: true, idempotent: false, finalOnFloor: 26 }, null, 2));