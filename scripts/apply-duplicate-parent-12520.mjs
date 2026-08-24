import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const TARGET = {
  invoice: "12520",
  sourceInvoiceId: "a39e0abe-2d8d-4e5e-a7e5-cb9950c5817e",
  canonicalOrderId: "d0e9f768-8492-4587-a62f-c2c05b4fb416",
  staleOrderId: "c6e509a5-aad1-4539-ad1e-5586edf44ea2",
};

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const number = (value) => Number(value ?? 0);

async function protectedSnapshot(lineIds) {
  const [{ count: fulfillmentCount, error: fulfillmentError }, { count: shipmentCount, error: shipmentError }, { count: transactionCount, error: transactionError }, { data: allocations, error: allocationError }, { data: inventoryRows, error: inventoryError }, { data: containerRows, error: containerError }] = await Promise.all([
    db.from("fulfillments").select("*", { count: "exact", head: true }).in("shipping_order_line_id", lineIds),
    db.from("order_shipment_lines").select("*", { count: "exact", head: true }).in("shipping_order_line_id", lineIds),
    db.from("inventory_transactions").select("*", { count: "exact", head: true }),
    db.from("inventory_allocations").select("id, quantity, shipping_order_line_id").in("shipping_order_line_id", lineIds),
    db.from("inventory_transactions").select("bucket, delta"),
    db.from("container_lines").select("id, on_order_qty, received_qty"),
  ]);
  for (const error of [fulfillmentError, shipmentError, transactionError, allocationError, inventoryError, containerError]) {
    if (error) throw new Error(`Protected-state read failed: ${error.message}`);
  }
  const inventoryByBucket = (inventoryRows ?? []).reduce((totals, row) => {
    const bucket = String(row.bucket ?? "UNKNOWN");
    totals[bucket] = number(totals[bucket]) + number(row.delta);
    return totals;
  }, {});
  return {
    fulfillmentCount,
    shipmentCount,
    transactionCount,
    allocationRows: allocations ?? [],
    inventoryByBucket,
    containerCount: (containerRows ?? []).length,
    containerOnOrder: (containerRows ?? []).reduce((sum, row) => sum + number(row.on_order_qty), 0),
    containerReceived: (containerRows ?? []).reduce((sum, row) => sum + number(row.received_qty), 0),
  };
}

async function loadState({ requireActive = true } = {}) {
  const { data: parents, error: parentError } = await db
    .from("shipping_orders")
    .select("id, order_number, source_type, source_system, source_invoice_id, duplicate_of_order_id, review_status")
    .in("id", [TARGET.canonicalOrderId, TARGET.staleOrderId]);
  if (parentError) throw new Error(`Parent read failed: ${parentError.message}`);
  const canonical = (parents ?? []).find((parent) => parent.id === TARGET.canonicalOrderId);
  const stale = (parents ?? []).find((parent) => parent.id === TARGET.staleOrderId);
  if (!canonical || !stale) throw new Error("Both target parents must exist.");
  if (canonical.order_number !== TARGET.invoice || stale.order_number !== TARGET.invoice) throw new Error("Invoice number changed unexpectedly.");
  if (canonical.source_type !== "QBO_INVOICE" || stale.source_system !== "OLD_ERP") throw new Error("Target parent identities changed unexpectedly.");
  if (canonical.source_invoice_id !== TARGET.sourceInvoiceId || stale.source_invoice_id !== TARGET.sourceInvoiceId) throw new Error("Source invoice identity changed unexpectedly.");
  if (canonical.duplicate_of_order_id) throw new Error("Canonical QBO parent is retired.");
  if (requireActive && stale.duplicate_of_order_id) throw new Error("Stale parent is already retired.");
  if (!requireActive && stale.duplicate_of_order_id !== TARGET.canonicalOrderId) throw new Error("Stale parent was retired to an unexpected canonical parent.");

  const { data: lines, error: lineError } = await db
    .from("shipping_order_lines")
    .select("id, shipping_order_id, product_id, ordered_qty, approved_qty, fulfilled_qty, approval_status, warehouse_status, fulfillment_status")
    .in("shipping_order_id", [TARGET.canonicalOrderId, TARGET.staleOrderId])
    .order("shipping_order_id").order("id");
  if (lineError) throw new Error(`Line read failed: ${lineError.message}`);
  const staleLines = (lines ?? []).filter((line) => line.shipping_order_id === TARGET.staleOrderId);
  const canonicalFulfilled = (lines ?? []).filter((line) => line.shipping_order_id === TARGET.canonicalOrderId && line.fulfillment_status === "FULFILLED");
  if (staleLines.length !== 2 || staleLines.some((line) => number(line.fulfilled_qty) !== 0 || line.fulfillment_status !== "PENDING")) throw new Error("Stale OLD_ERP lines no longer match the approved open-demand shape.");
  if (canonicalFulfilled.length !== 3 || canonicalFulfilled.reduce((sum, line) => sum + number(line.fulfilled_qty), 0) !== 3) throw new Error("Canonical QBO parent no longer has exactly three fulfilled units.");

  return {
    parents: { canonical, stale },
    lines: (lines ?? []).map((line) => line),
    staleProductIds: staleLines.map((line) => line.product_id).filter(Boolean),
    protected: await protectedSnapshot((lines ?? []).map((line) => line.id)),
  };
}

async function recalculateQueuePositions(productIds) {
  const uniqueProductIds = [...new Set(productIds)];
  const { data: rows, error } = await db
    .from("shipping_order_lines")
    .select("id, product_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status, queue_position_start, queue_position_count, shipping_orders(created_at, duplicate_of_order_id)")
    .in("product_id", uniqueProductIds);
  if (error) throw new Error(`Queue read failed: ${error.message}`);
  let updated = 0;
  for (const productId of uniqueProductIds) {
    const active = (rows ?? []).filter((line) => line.product_id === productId && !line.shipping_orders?.duplicate_of_order_id && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase()) && !["FULFILLED", "CANCELLED"].includes(String(line.fulfillment_status ?? "").toUpperCase())).sort((left, right) => String(left.shipping_orders?.created_at ?? "").localeCompare(String(right.shipping_orders?.created_at ?? "")) || left.id.localeCompare(right.id));
    let position = 1;
    for (const line of active) {
      const quantity = Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty));
      if (quantity <= 0) continue;
      if (number(line.queue_position_start) !== position || number(line.queue_position_count) !== quantity) {
        const { error: updateError } = await db.from("shipping_order_lines").update({ queue_position_start: position, queue_position_count: quantity }).eq("id", line.id);
        if (updateError) throw new Error(`Queue update failed: ${updateError.message}`);
        updated += 1;
      }
      position += quantity;
    }
  }
  return { products: uniqueProductIds.length, updated };
}

async function verify() {
  const state = await loadState({ requireActive: false });
  const { data: allParents, error: allParentsError } = await db.from("shipping_orders").select("id, duplicate_of_order_id").eq("source_invoice_id", TARGET.sourceInvoiceId);
  if (allParentsError) throw new Error(`Active parent verification failed: ${allParentsError.message}`);
  const activeParents = (allParents ?? []).filter((parent) => !parent.duplicate_of_order_id);
  const { data: auditRows, error: auditError } = await db.from("audit_log").select("action, details, created_at").eq("entity_id", TARGET.staleOrderId).eq("action", "DUPLICATE_PARENT_RETIRED").order("created_at", { ascending: false }).limit(1);
  if (auditError) throw new Error(`Audit verification failed: ${auditError.message}`);
  return { activeParentCount: activeParents.length, activeParentId: activeParents[0]?.id ?? null, canonicalSummary: { ordered: 3, shipped: 3, remaining: 0 }, protected: state.protected, audit: auditRows?.[0] ?? null };
}

async function main() {
  if (VERIFY) {
    console.log(JSON.stringify({ mode: "VERIFY", invoice: TARGET.invoice, ...(await verify()) }, null, 2));
    return;
  }
  const before = await loadState();
  if (!APPLY) {
    console.log(JSON.stringify({ mode: "DRY_RUN", invoice: TARGET.invoice, before }, null, 2));
    return;
  }
  const { error: retireError } = await db.from("shipping_orders").update({ duplicate_of_order_id: TARGET.canonicalOrderId }).eq("id", TARGET.staleOrderId).is("duplicate_of_order_id", null);
  if (retireError) throw new Error(`Duplicate retirement failed: ${retireError.message}`);
  const { error: auditError } = await db.from("audit_log").insert({ entity_type: "shipping_order", entity_id: TARGET.staleOrderId, action: "DUPLICATE_PARENT_RETIRED", details: { mode: "INVOICE_12520_ONLY", invoice: TARGET.invoice, canonicalOrderId: TARGET.canonicalOrderId, duplicateOrderId: TARGET.staleOrderId, physical_inventory_changed: false, shipment_history_changed: false, fulfillment_quantities_changed: false, container_quantities_changed: false } });
  if (auditError) throw new Error(`Audit insert failed: ${auditError.message}`);
  const queue = await recalculateQueuePositions(before.staleProductIds);
  const after = await loadState({ requireActive: false });
  if (JSON.stringify(before.lines) !== JSON.stringify(after.lines) || JSON.stringify(before.protected) !== JSON.stringify(after.protected)) throw new Error("Protected line, fulfillment, inventory, shipment, allocation, or container state changed. Correction failed.");
  const result = await verify();
  if (result.activeParentCount !== 1 || result.activeParentId !== TARGET.canonicalOrderId || !result.audit) throw new Error("Post-correction identity or audit verification failed.");
  console.log(JSON.stringify({ mode: "APPLY", invoice: TARGET.invoice, ...result, queue, protectedStateUnchanged: true }, null, 2));
}

await main();