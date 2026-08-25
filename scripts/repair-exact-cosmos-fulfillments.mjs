#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const REPORT_DIR = "tmp/import-reports";
const EVENT_PREFIX = "COSMOS_FULFILLED_INVOICE_ROW:";

// This list is deliberately closed. Additions require a separate reviewed repair.
const MANIFEST = [
  ["c013db50-20dc-40e4-8412-0086f70a21fd", "11359", "2PCFHD-15", "2026-04-27T14:33:36.199Z"],
  ["d9911450-6d59-402e-917d-7bdecad0764d", "11359", "2PFC", "2026-04-27T14:33:36.199Z"],
  ["0f594400-3a86-456b-899f-4d7b34e69eeb", "11359", "4PTA-6", "2026-04-27T14:33:36.199Z"],
  ["3056e8b6-66da-439d-b495-e619f70d4324", "11359", "HPU2203", "2026-04-27T14:33:36.199Z"],
  ["b0d3ddc7-d45f-4568-8631-55491eb59912", "11359", "UHS-5075", "2026-04-27T14:33:36.199Z"],
  ["2be67ef3-65ef-4cf1-ba7c-c94fff025d1f", "12066", "4PXL-10", "2026-04-24T15:47:23.590Z"],
  ["f86ddddb-ae29-4e62-8530-f3b936360f3d", "12066", "HPU1103", "2026-04-24T15:47:23.590Z"],
  ["606d8b0b-43e6-4fa9-8d88-49d5e06bb539", "12066", "RJT-10", "2026-04-24T15:47:23.590Z"],
  ["507da5d3-5364-42fc-80df-c642b43fba0b", "12103", "4PTT-XL10", "2026-04-24T15:48:00.365Z"],
  ["c888e1dc-f895-46fe-91d5-9eead31e4c22", "12103", "4PXL-10", "2026-04-24T15:48:00.365Z"],
  ["2ef33a50-9d1c-49b2-b8c2-e18c29c9831d", "12103", "HPU2203", "2026-04-24T15:48:00.365Z"],
  ["c865d58c-0245-4802-bd95-70ef2d44ac31", "12103", "RJT-10", "2026-04-24T15:48:00.365Z"],
  ["4eea57d8-ff6b-4fd4-b49c-ff4bbef7d80c", "12302", "2PCF-9", "2026-04-24T17:26:12.183Z"],
  ["e3b3628e-504c-484a-b2d8-0caf50f683be", "12302", "2PFC", "2026-04-24T17:26:12.183Z"],
  ["84eb56ca-cad0-4753-84a1-209f8cc59fb3", "12302", "4PTA-6", "2026-04-24T17:26:12.183Z"],
  ["16a2eaa9-2a1c-4274-b64c-0fca7a1c91bf", "12302", "EPOXY-132488", "2026-04-24T17:26:12.183Z"],
  ["fd5e7061-63f0-4a9c-bcd3-8bc7772849b6", "12302", "HPU1103", "2026-04-24T17:26:12.183Z"],
].map(([sourceRecordId, invoiceNumber, sku, fulfilledAt]) => ({ sourceRecordId, invoiceNumber, sku, fulfilledAt }));

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase credentials. Run with --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sources = MANIFEST.map((item) => item.sourceRecordId);
const upper = (value) => String(value ?? "").trim().toUpperCase();
const amount = (value) => Number(value ?? 0);
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

async function fetchRows(table, select, column, values) {
  if (values.length === 0) return [];
  const { data, error } = await db.from(table).select(select).in(column, values);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

function assertManifestLines(lines) {
  const linesBySource = new Map();
  for (const line of lines) linesBySource.set(line.source_record_id, [...(linesBySource.get(line.source_record_id) ?? []), line]);

  for (const item of MANIFEST) {
    const matches = linesBySource.get(item.sourceRecordId) ?? [];
    if (matches.length !== 1) throw new Error(`${item.sourceRecordId}: expected one exact source line, found ${matches.length}`);
    const line = matches[0];
    if (upper(line.legacy_item_code) !== item.sku || amount(line.approved_qty) !== 1 || amount(line.ordered_qty) !== 1) {
      throw new Error(`${item.sourceRecordId}: source line no longer matches the approved invoice/SKU/quantity manifest`);
    }
    if (amount(line.fulfilled_qty) > 1) throw new Error(`${item.sourceRecordId}: fulfillment exceeds approved quantity`);
  }
}

async function main() {
  const lines = await fetchRows(
    "shipping_order_lines",
    "id,shipping_order_id,product_id,source_record_id,legacy_item_code,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,queue_position_start,queue_position_count",
    "source_record_id",
    sources,
  );
  assertManifestLines(lines);

  const lineIds = lines.map((line) => line.id);
  const orderIds = [...new Set(lines.map((line) => line.shipping_order_id))];
  const productIds = [...new Set(lines.map((line) => line.product_id))];
  const [orders, allOrderLines, existingFulfillments, existingResolutions, inventoryTransactions] = await Promise.all([
    fetchRows("shipping_orders", "id,order_number,review_status", "id", orderIds),
    fetchRows("shipping_order_lines", "id,shipping_order_id,approved_qty,fulfilled_qty,fulfillment_status", "shipping_order_id", orderIds),
    fetchRows("fulfillments", "id,shipping_order_line_id,fulfilled_qty,fulfilled_at,source_event_key,fulfillment_type,reason", "shipping_order_line_id", lineIds),
    fetchRows("reviewed_obligation_resolutions", "id,source_record_id,qbo_invoice_line_id,resolution_type,status,resolution_note,reviewed_at", "source_record_id", sources),
    fetchRows("inventory_transactions", "id,product_id,bucket,delta,source_event_key,shipping_order_line_id", "product_id", productIds),
  ]);

  const backup = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? "apply" : "preview",
    manifest: MANIFEST,
    shippingOrderLines: lines,
    shippingOrders: orders,
    parentOrderLines: allOrderLines,
    fulfillments: existingFulfillments,
    reviewedObligationResolutions: existingResolutions,
    inventoryTransactions,
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const backupPath = path.join(REPORT_DIR, `exact-cosmos-fulfillment-repair-backup-${timestamp()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

  const summary = { requested: MANIFEST.length, repaired: 0, alreadyCorrect: 0, failed: 0, backupPath, changes: [] };
  if (!APPLY) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const manifestBySource = new Map(MANIFEST.map((item) => [item.sourceRecordId, item]));
  for (const line of lines) {
    const item = manifestBySource.get(line.source_record_id);
    const eventKey = `${EVENT_PREFIX}${item.sourceRecordId}`;
    const existingEvent = existingFulfillments.find((event) => event.source_event_key === eventKey);
    const existingResolution = existingResolutions.find((resolution) => upper(resolution.status) === "ACTIVE");
    if (amount(line.fulfilled_qty) >= 1 && existingEvent && existingResolution) {
      summary.alreadyCorrect += 1;
      continue;
    }

    const { error: fulfillmentError } = await db.from("fulfillments").upsert({
      shipping_order_line_id: line.id,
      fulfilled_qty: 1,
      fulfilled_at: item.fulfilledAt,
      reason: `Historical Cosmos fulfillment for invoice ${item.invoiceNumber}; migrated without physical inventory movement.`,
      source_event_key: eventKey,
      fulfillment_type: "OTHER",
    }, { onConflict: "shipping_order_line_id,source_event_key" });
    if (fulfillmentError) throw new Error(`${item.sourceRecordId}: fulfillment upsert failed: ${fulfillmentError.message}`);

    const { error: lineError } = await db.from("shipping_order_lines").update({
      fulfilled_qty: 1,
      fulfillment_status: "FULFILLED",
      warehouse_status: "FULFILLED",
      queue_position_start: null,
      queue_position_count: null,
    }).eq("id", line.id).eq("source_record_id", item.sourceRecordId);
    if (lineError) throw new Error(`${item.sourceRecordId}: line update failed: ${lineError.message}`);

    const resolutionPayload = {
      source_record_id: item.sourceRecordId,
      resolution_type: "HISTORICAL_FULFILLMENT",
      status: "ACTIVE",
      resolution_note: `Exact Cosmos FulfilledInvoiceRows source evidence; invoice ${item.invoiceNumber}, SKU ${item.sku}, fulfilled ${item.fulfilledAt}.`,
      reviewed_at: item.fulfilledAt,
    };
    const resolutionMutation = existingResolution
      ? db.from("reviewed_obligation_resolutions").update(resolutionPayload).eq("id", existingResolution.id)
      : db.from("reviewed_obligation_resolutions").insert(resolutionPayload);
    const { error: resolutionError } = await resolutionMutation;
    if (resolutionError) throw new Error(`${item.sourceRecordId}: historical resolution upsert failed: ${resolutionError.message}`);

    summary.repaired += 1;
    summary.changes.push({ sourceRecordId: item.sourceRecordId, lineId: line.id, eventKey });
  }

  const refreshedOrderLines = await fetchRows("shipping_order_lines", "shipping_order_id,approved_qty,fulfilled_qty,fulfillment_status", "shipping_order_id", orderIds);
  for (const order of orders) {
    const parentLines = refreshedOrderLines.filter((line) => line.shipping_order_id === order.id);
    const allFulfilled = parentLines.length > 0 && parentLines.every((line) => amount(line.fulfilled_qty) >= amount(line.approved_qty) || upper(line.fulfillment_status) === "FULFILLED");
    if (!allFulfilled) continue;
    const { error } = await db.from("shipping_orders").update({ review_status: "FULFILLED" }).eq("id", order.id);
    if (error) throw new Error(`${order.order_number}: parent lifecycle update failed: ${error.message}`);
  }

  const postTransactions = await fetchRows("inventory_transactions", "id,product_id,bucket,delta,source_event_key,shipping_order_line_id", "product_id", productIds);
  if (JSON.stringify(inventoryTransactions) !== JSON.stringify(postTransactions)) {
    throw new Error("Physical inventory ledger changed unexpectedly; stop and restore from the backup before any further action.");
  }

  const reportPath = path.join(REPORT_DIR, `exact-cosmos-fulfillment-repair-result-${timestamp()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...summary, postTransactions }, null, 2));
  console.log(JSON.stringify({ ...summary, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});