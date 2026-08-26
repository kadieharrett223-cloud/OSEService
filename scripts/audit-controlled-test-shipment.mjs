#!/usr/bin/env node

import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const invoiceNumber = process.argv.find((argument) => argument.startsWith("--invoice="))?.slice("--invoice=".length) ?? "127052";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase credentials. Run with node --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const number = (value) => Number(value ?? 0);
const upper = (value) => String(value ?? "").trim().toUpperCase();
const closed = new Set(["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

const { data: orders, error: orderError } = await db
  .from("shipping_orders")
  .select("id,order_number,review_status,cancellation_status,source_invoice_id,qbo_invoices(invoice_number,payment_status,raw_payload)")
  .eq("order_number", invoiceNumber)
  .is("duplicate_of_order_id", null);
if (orderError) throw orderError;
if ((orders ?? []).length !== 1) throw new Error(`Expected exactly one canonical ERP parent for invoice ${invoiceNumber}; found ${(orders ?? []).length}.`);

const order = orders[0];
const { data: lines, error: lineError } = await db
  .from("shipping_order_lines")
  .select("id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,fulfillment_source,products(sku,canonical_name)")
  .eq("shipping_order_id", order.id);
if (lineError) throw lineError;
if ((lines ?? []).length !== 1) throw new Error(`Expected exactly one order line for invoice ${invoiceNumber}; found ${(lines ?? []).length}.`);

const line = lines[0];
if (!line.product_id) throw new Error(`Invoice ${invoiceNumber} does not have a mapped product.`);
const demand = Math.max(number(line.ordered_qty), number(line.approved_qty));

const { data: shipmentRows, error: shipmentError } = await db
  .from("order_shipments")
  .select("id,shipment_number,shipped_at,order_shipment_lines(id,shipping_order_line_id,quantity)")
  .eq("shipping_order_id", order.id);
if (shipmentError) throw shipmentError;
const shipmentLines = (shipmentRows ?? []).flatMap((shipment) => (shipment.order_shipment_lines ?? [])
  .filter((shipmentLine) => shipmentLine.shipping_order_line_id === line.id)
  .map((shipmentLine) => ({ shipment, shipmentLine })));

const [{ data: fulfillments, error: fulfillmentError }, { data: lineTransactions, error: transactionError }, { data: productTransactions, error: productTransactionError }, { data: productLines, error: productLinesError }] = await Promise.all([
  db.from("fulfillments").select("id,fulfilled_qty,fulfilled_at,fulfillment_type,source_event_key").eq("shipping_order_line_id", line.id),
  db.from("inventory_transactions").select("id,bucket,delta,before_qty,after_qty,reason,source_type,source_event_key,created_at").eq("shipping_order_line_id", line.id).order("created_at"),
  db.from("inventory_transactions").select("id,bucket,delta,before_qty,after_qty,reason,source_type,source_event_key,shipping_order_line_id,created_at").eq("product_id", line.product_id).order("created_at"),
  db.from("shipping_order_lines").select("id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,shipping_orders(cancellation_status,duplicate_of_order_id)").eq("product_id", line.product_id),
]);
if (fulfillmentError) throw fulfillmentError;
if (transactionError) throw transactionError;
if (productTransactionError) throw productTransactionError;
if (productLinesError) throw productLinesError;

const shipmentQuantity = shipmentLines.reduce((sum, row) => sum + number(row.shipmentLine.quantity), 0);
const fulfillmentQuantity = (fulfillments ?? []).reduce((sum, fulfillment) => sum + number(fulfillment.fulfilled_qty), 0);
const floorTransactions = (lineTransactions ?? []).filter((transaction) => transaction.bucket === "ON_FLOOR");
const shipmentFloorDelta = floorTransactions.reduce((sum, transaction) => sum + number(transaction.delta), 0);
const currentOnFloor = (productTransactions ?? [])
  .filter((transaction) => transaction.bucket === "ON_FLOOR")
  .reduce((sum, transaction) => sum + number(transaction.delta), 0);
const activeDemandAfter = (productLines ?? []).reduce((sum, productLine) => {
  const parent = productLine.shipping_orders;
  if (parent?.duplicate_of_order_id || upper(parent?.cancellation_status) === "CANCELLED") return sum;
  if (closed.has(upper(productLine.approval_status)) || closed.has(upper(productLine.fulfillment_status))) return sum;
  return sum + Math.max(0, Math.max(number(productLine.ordered_qty), number(productLine.approved_qty)) - number(productLine.fulfilled_qty));
}, 0);

const checks = {
  oneOrder: (orders ?? []).length === 1,
  oneLine: (lines ?? []).length === 1,
  orderedAndFulfilledOnce: demand === 1 && number(line.fulfilled_qty) === 1 && shipmentQuantity === 1 && fulfillmentQuantity === 1,
  noOpenDemandOnTestLine: Math.max(0, demand - number(line.fulfilled_qty)) === 0,
  onePhysicalDecrement: floorTransactions.length === 1 && shipmentFloorDelta === -1,
  shipmentMatchesInventory: shipmentQuantity === -shipmentFloorDelta,
};

const report = {
  readOnly: true,
  invoiceNumber,
  order: {
    id: order.id,
    reviewStatus: order.review_status,
    cancellationStatus: order.cancellation_status,
    qboPaymentStatus: order.qbo_invoices?.payment_status ?? null,
  },
  line: {
    id: line.id,
    sku: line.products?.sku ?? null,
    ordered: demand,
    fulfilled: number(line.fulfilled_qty),
    remaining: Math.max(0, demand - number(line.fulfilled_qty)),
    fulfillmentStatus: line.fulfillment_status,
    warehouseStatus: line.warehouse_status,
    fulfillmentSource: line.fulfillment_source ?? "WAREHOUSE",
  },
  evidence: {
    shipments: shipmentLines.map((row) => ({ id: row.shipment.id, number: row.shipment.shipment_number, shippedAt: row.shipment.shipped_at, quantity: number(row.shipmentLine.quantity) })),
    fulfillments: fulfillments ?? [],
    onFloorTransactions: floorTransactions,
  },
  productTotals: {
    onFloorBeforeShipment: floorTransactions.length === 1 ? number(floorTransactions[0].before_qty) : null,
    onFloorAfterShipment: floorTransactions.length === 1 ? number(floorTransactions[0].after_qty) : null,
    onFloorCurrent: currentOnFloor,
    openDemandBeforeShipment: activeDemandAfter + 1,
    openDemandAfterShipment: activeDemandAfter,
  },
  checks,
  passes: Object.values(checks).every(Boolean),
};

console.log(JSON.stringify(report, null, 2));
if (!report.passes) process.exitCode = 1;