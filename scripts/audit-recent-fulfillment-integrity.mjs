import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="));
const since = sinceArgument?.slice("--since=".length) || new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
const number = (value) => Number(value ?? 0);
const chunks = (values, size = 100) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

async function fetchAllShipments() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("order_shipments")
      .select("id,shipping_order_id,shipment_number,shipped_at,order_shipment_lines(quantity,shipping_order_line_id)")
      .gte("shipped_at", since)
      .order("shipped_at")
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function fetchByLineIds(table, select, lineIds) {
  const rows = [];
  for (const chunk of chunks(lineIds)) {
    const { data, error } = await db.from(table).select(select).in("shipping_order_line_id", chunk);
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

const shipments = await fetchAllShipments();
const shipmentLines = shipments.flatMap((shipment) => (shipment.order_shipment_lines ?? []).map((line) => ({ shipment, ...line })));
const lineIds = [...new Set(shipmentLines.map((line) => line.shipping_order_line_id))];

if (lineIds.length === 0) {
  console.log(JSON.stringify({ readOnly: true, since, shipments: 0, shipmentLines: 0, failures: [] }, null, 2));
  process.exit(0);
}

const [lines, fulfillments, transactions] = await Promise.all([
  (async () => {
    const rows = [];
    for (const chunk of chunks(lineIds)) {
      const { data, error } = await db
        .from("shipping_order_lines")
        .select("id,product_id,ordered_qty,approved_qty,fulfilled_qty,fulfillment_status,fulfillment_source,products(sku)")
        .in("id", chunk);
      if (error) throw error;
      rows.push(...(data ?? []));
    }
    return rows;
  })(),
  fetchByLineIds("fulfillments", "shipping_order_line_id,fulfilled_qty,fulfillment_type,source_event_key", lineIds),
  fetchByLineIds("inventory_transactions", "shipping_order_line_id,bucket,delta,source_event_key", lineIds),
]);

const linesById = new Map(lines.map((line) => [line.id, line]));
const fulfillmentsByLine = Map.groupBy(fulfillments, (row) => row.shipping_order_line_id);
const transactionsByLine = Map.groupBy(transactions, (row) => row.shipping_order_line_id);
const checks = shipmentLines.map((shipmentLine) => {
  const shipment = shipmentLine.shipment;
  const line = linesById.get(shipmentLine.shipping_order_line_id);
  const quantity = number(shipmentLine.quantity);
  const source = String(line?.fulfillment_source ?? "WAREHOUSE").trim().toUpperCase() || "WAREHOUSE";
  const eventPrefix = `ORDER_SHIPMENT:${shipment.id}:${shipmentLine.shipping_order_line_id}`;
  const lineFulfillments = fulfillmentsByLine.get(shipmentLine.shipping_order_line_id) ?? [];
  const shipmentEvidence = lineFulfillments
    .filter((row) => String(row.source_event_key ?? "").startsWith(eventPrefix))
    .reduce((sum, row) => sum + number(row.fulfilled_qty), 0);
  const fulfillmentLedger = lineFulfillments.reduce((sum, row) => sum + number(row.fulfilled_qty), 0);
  const inventoryEvents = (transactionsByLine.get(shipmentLine.shipping_order_line_id) ?? [])
    .filter((row) => String(row.source_event_key ?? "").startsWith(eventPrefix));
  const floorDelta = inventoryEvents.filter((row) => row.bucket === "ON_FLOOR").reduce((sum, row) => sum + number(row.delta), 0);
  const demand = Math.max(number(line?.approved_qty), number(line?.ordered_qty));
  const remaining = Math.max(0, demand - number(line?.fulfilled_qty));
  const external = source === "DROPSHIP" || source === "OTHER";
  const inventoryPass = external
    ? inventoryEvents.length === 0
    : floorDelta === -quantity && inventoryEvents.every((row) => row.bucket === "ON_FLOOR");
  const customerDemandPass = Math.abs(fulfillmentLedger - number(line?.fulfilled_qty)) < 0.001
    && remaining === Math.max(0, demand - fulfillmentLedger);
  return {
    invoiceOwnerId: shipment.shipping_order_id,
    shipment: shipment.shipment_number,
    lineId: shipmentLine.shipping_order_line_id,
    sku: line?.products?.sku ?? null,
    source,
    shipped: quantity,
    remainingCustomerDemand: remaining,
    shipmentEvidence,
    fulfillmentLedger,
    floorDelta,
    inventoryEvents: inventoryEvents.length,
    checks: {
      shipmentEvidence: shipmentEvidence === quantity,
      inventory: inventoryPass,
      customerDemand: customerDemandPass,
    },
  };
});

const failures = checks.filter((check) => !Object.values(check.checks).every(Boolean));
console.log(JSON.stringify({
  readOnly: true,
  since,
  shipments: shipments.length,
  shipmentLines: checks.length,
  passed: checks.length - failures.length,
  failed: failures.length,
  bySource: Object.fromEntries(Object.entries(Object.groupBy(checks, (check) => check.source)).map(([source, rows]) => [source, { lines: rows.length, failures: rows.filter((row) => !Object.values(row.checks).every(Boolean)).length }])),
  failures,
}, null, 2));

if (failures.length > 0) process.exitCode = 1;