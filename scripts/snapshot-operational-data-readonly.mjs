import { createHash } from "node:crypto";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const label = process.argv[2];
if (!label || !["before", "after"].includes(label)) throw new Error("Use: node --env-file=.env.local scripts/snapshot-operational-data-readonly.mjs before|after");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const tables = [
  ["shipping_orders", "id,source_invoice_id,duplicate_of_order_id,cancellation_status,review_status,order_number"],
  ["shipping_order_lines", "id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,queue_position_start,queue_position_count"],
  ["fulfillments", "id,shipping_order_line_id,fulfilled_qty,shipment_number,tracking_number,fulfilled_at"],
  ["order_shipments", "id,shipping_order_id,shipment_number,shipped_at,carrier,tracking_number"],
  ["order_shipment_lines", "id,shipment_id,shipping_order_line_id,quantity"],
  ["inventory_allocations", "id,shipping_order_line_id,product_id,container_id,quantity,allocation_status,source_type"],
  ["inventory_transactions", "id,shipping_order_line_id,product_id,container_id,bucket,delta,source_type,source_event_key"],
  ["containers", "id,container_number,lifecycle_status,eta_confirmed_date,eta_estimated_date"],
  ["container_lines", "id,container_id,product_id,on_order_qty,received_qty"],
  ["qbo_invoices", "id,invoice_number,payment_status,raw_payload"],
  ["audit_log", "id,entity_type,entity_id,action,details,created_at"],
];

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

const entries = await Promise.all(tables.map(async ([table, select]) => {
  const rows = await loadAll(table, select);
  const stable = rows.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return [table, { count: stable.length, sha256: createHash("sha256").update(JSON.stringify(stable)).digest("hex") }];
}));
const snapshot = { generatedAt: new Date().toISOString(), readOnly: true, label, tables: Object.fromEntries(entries) };
fs.writeFileSync(`tmp/import-reports/orders-display-rollback-${label}-snapshot.json`, JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify(snapshot, null, 2));