import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const TARGET = {
  invoice: "126079",
  canonicalOrderId: "f34059ce-79d0-4a90-830a-ebc80b83d507",
  staleOrderId: "d3292c28-1d7d-4088-909b-78159ca4614a",
  expectedSourceInvoiceId: "69a98752-11f3-40a9-b527-cedd28700037",
};

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const number = (value) => Number(value ?? 0);

async function loadBaseline() {
  const { data: parents, error: parentsError } = await supabase
    .from("shipping_orders")
    .select("id, order_number, source_type, source_system, source_invoice_id, duplicate_of_order_id, review_status")
    .in("id", [TARGET.canonicalOrderId, TARGET.staleOrderId]);
  if (parentsError) throw new Error(`Parent read failed: ${parentsError.message}`);

  const canonical = (parents ?? []).find((parent) => parent.id === TARGET.canonicalOrderId);
  const stale = (parents ?? []).find((parent) => parent.id === TARGET.staleOrderId);
  if (!canonical || !stale) throw new Error("Expected canonical and stale parents were not both found.");
  if (canonical.order_number !== TARGET.invoice || stale.order_number !== TARGET.invoice) throw new Error("Invoice number changed unexpectedly.");
  if (canonical.source_type !== "QBO_INVOICE" || stale.source_system !== "OLD_ERP") throw new Error("Parent identities no longer match the approved correction.");
  if (canonical.source_invoice_id !== TARGET.expectedSourceInvoiceId || stale.source_invoice_id !== TARGET.expectedSourceInvoiceId) throw new Error("Source invoice identity changed unexpectedly.");
  if (canonical.duplicate_of_order_id || stale.duplicate_of_order_id) throw new Error("A target parent is already retired; refusing to overwrite state.");

  const { data: lines, error: linesError } = await supabase
    .from("shipping_order_lines")
    .select("id, shipping_order_id, product_id, legacy_item_code, ordered_qty, approved_qty, fulfilled_qty, approval_status, warehouse_status, fulfillment_status, queue_position_start, queue_position_count")
    .in("shipping_order_id", [TARGET.canonicalOrderId, TARGET.staleOrderId])
    .order("shipping_order_id")
    .order("id");
  if (linesError) throw new Error(`Line read failed: ${linesError.message}`);

  const staleLines = (lines ?? []).filter((line) => line.shipping_order_id === TARGET.staleOrderId);
  const canonicalFulfilled = (lines ?? []).filter((line) => line.shipping_order_id === TARGET.canonicalOrderId && line.fulfillment_status === "FULFILLED");
  if (staleLines.length !== 1 || number(staleLines[0].fulfilled_qty) !== 0 || staleLines[0].fulfillment_status !== "PENDING") throw new Error("Stale OLD_ERP line no longer matches the approved open-demand shape.");
  if (canonicalFulfilled.length !== 3 || canonicalFulfilled.reduce((sum, line) => sum + number(line.fulfilled_qty), 0) !== 3) throw new Error("Canonical QBO parent no longer has exactly three fulfilled units.");

  const lineIds = (lines ?? []).map((line) => line.id);
  const [{ count: fulfillmentCount, error: fulfillmentError }, { count: shipmentCount, error: shipmentError }, { count: transactionCount, error: transactionError }, { data: allocations, error: allocationError }, { data: inventoryRows, error: inventoryError }, { data: containerRows, error: containerError }] = await Promise.all([
    supabase.from("fulfillments").select("*", { count: "exact", head: true }).in("shipping_order_line_id", lineIds),
    supabase.from("order_shipment_lines").select("*", { count: "exact", head: true }).in("shipping_order_line_id", lineIds),
    supabase.from("inventory_transactions").select("*", { count: "exact", head: true }),
    supabase.from("inventory_allocations").select("id, quantity, shipping_order_line_id").in("shipping_order_line_id", lineIds),
    supabase.from("inventory_transactions").select("bucket, delta"),
    supabase.from("container_lines").select("id, on_order_qty, received_qty"),
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
    parents: { canonical, stale },
    lines: (lines ?? []).map(({ queue_position_start, queue_position_count, ...line }) => line),
    staleProductIds: staleLines.map((line) => line.product_id).filter(Boolean),
    protected: {
      fulfillmentCount,
      shipmentCount,
      transactionCount,
      allocationRows: allocations ?? [],
      inventoryByBucket,
      containerCount: (containerRows ?? []).length,
      containerOnOrder: (containerRows ?? []).reduce((sum, row) => sum + number(row.on_order_qty), 0),
      containerReceived: (containerRows ?? []).reduce((sum, row) => sum + number(row.received_qty), 0),
    },
  };
}

async function recalculateQueuePositions(productIds) {
  const uniqueProductIds = [...new Set(productIds)];
  const { data: rows, error } = await supabase
    .from("shipping_order_lines")
    .select("id, product_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status, queue_position_override, queue_position_start, queue_position_count, shipping_orders(created_at, duplicate_of_order_id)")
    .in("product_id", uniqueProductIds);
  if (error) throw new Error(`Queue read failed: ${error.message}`);

  let updated = 0;
  for (const productId of uniqueProductIds) {
    const active = (rows ?? []).filter((line) => line.product_id === productId
      && !line.shipping_orders?.duplicate_of_order_id
      && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase())
      && !["FULFILLED", "CANCELLED"].includes(String(line.fulfillment_status ?? "").toUpperCase()))
      .sort((left, right) => String(left.shipping_orders?.created_at ?? "").localeCompare(String(right.shipping_orders?.created_at ?? "")) || left.id.localeCompare(right.id));
    let position = 1;
    for (const line of active) {
      const quantity = Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty));
      if (quantity <= 0) continue;
      if (number(line.queue_position_start) !== position || number(line.queue_position_count) !== quantity) {
        const { error: updateError } = await supabase.from("shipping_order_lines").update({ queue_position_start: position, queue_position_count: quantity }).eq("id", line.id);
        if (updateError) throw new Error(`Queue update failed: ${updateError.message}`);
        updated += 1;
      }
      position += quantity;
    }
  }
  return { products: uniqueProductIds.length, updated };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  if (VERIFY) {
    const after = await loadBaselineAfterRaw();
    const { data: auditRows, error: auditError } = await supabase
      .from("audit_log")
      .select("action, details, created_at")
      .eq("entity_id", TARGET.staleOrderId)
      .eq("action", "DUPLICATE_PARENT_RETIRED")
      .order("created_at", { ascending: false })
      .limit(1);
    if (auditError) throw new Error(`Audit verification failed: ${auditError.message}`);
    console.log(JSON.stringify({
      mode: "VERIFY",
      invoice: TARGET.invoice,
      activeParentCount: after.activeParentCount,
      activeParentId: after.activeParentId,
      canonicalSummary: after.canonicalSummary,
      protected: after.protected,
      audit: auditRows?.[0] ?? null,
    }, null, 2));
    return;
  }

  const before = await loadBaseline();
  if (!APPLY) {
    console.log(JSON.stringify({ mode: "DRY_RUN", invoice: TARGET.invoice, before }, null, 2));
    return;
  }

  const { error: retireError } = await supabase
    .from("shipping_orders")
    .update({ duplicate_of_order_id: TARGET.canonicalOrderId })
    .eq("id", TARGET.staleOrderId)
    .is("duplicate_of_order_id", null);
  if (retireError) throw new Error(`Duplicate retirement failed: ${retireError.message}`);

  const { error: auditError } = await supabase.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: TARGET.staleOrderId,
    action: "DUPLICATE_PARENT_RETIRED",
    details: {
      mode: "INVOICE_126079_ONLY",
      invoice: TARGET.invoice,
      canonicalOrderId: TARGET.canonicalOrderId,
      duplicateOrderId: TARGET.staleOrderId,
      physical_inventory_changed: false,
      shipment_history_changed: false,
      fulfillment_quantities_changed: false,
      container_quantities_changed: false,
    },
  });
  if (auditError) throw new Error(`Audit insert failed: ${auditError.message}`);

  const queue = await recalculateQueuePositions(before.staleProductIds);
  const after = await loadBaselineAfter();
  if (!sameJson(before.lines, after.lines) || !sameJson(before.protected, after.protected)) {
    throw new Error("Protected fulfillment, inventory, shipment, allocation, or container state changed. Correction failed.");
  }
  if (after.activeParentCount !== 1 || after.activeParentId !== TARGET.canonicalOrderId) throw new Error("Expected exactly one active canonical parent after retirement.");
  if (after.canonicalSummary.ordered !== 3 || after.canonicalSummary.shipped !== 3 || after.canonicalSummary.remaining !== 0) throw new Error("Canonical order no longer matches the required 3 ordered / 3 shipped / 0 remaining state.");

  console.log(JSON.stringify({ mode: "APPLY", invoice: TARGET.invoice, activeParentId: after.activeParentId, canonicalSummary: after.canonicalSummary, queue, protectedStateUnchanged: true }, null, 2));
}

async function loadBaselineAfter() {
  const baseline = await loadBaselineAfterRaw();
  return baseline;
}

async function loadBaselineAfterRaw() {
  const { data: parents, error: parentError } = await supabase.from("shipping_orders").select("id, duplicate_of_order_id").eq("source_invoice_id", TARGET.expectedSourceInvoiceId);
  if (parentError) throw new Error(`Post-correction parent read failed: ${parentError.message}`);
  const active = (parents ?? []).filter((parent) => !parent.duplicate_of_order_id);
  const { data: lines, error: lineError } = await supabase.from("shipping_order_lines").select("id, shipping_order_id, product_id, legacy_item_code, ordered_qty, approved_qty, fulfilled_qty, approval_status, warehouse_status, fulfillment_status").in("shipping_order_id", [TARGET.canonicalOrderId, TARGET.staleOrderId]).order("shipping_order_id").order("id");
  if (lineError) throw new Error(`Post-correction line read failed: ${lineError.message}`);
  const lineIds = (lines ?? []).map((line) => line.id);
  const [{ count: fulfillmentCount }, { count: shipmentCount }, { count: transactionCount }, { data: allocations }, { data: inventoryRows }, { data: containerRows }] = await Promise.all([
    supabase.from("fulfillments").select("*", { count: "exact", head: true }).in("shipping_order_line_id", lineIds),
    supabase.from("order_shipment_lines").select("*", { count: "exact", head: true }).in("shipping_order_line_id", lineIds),
    supabase.from("inventory_transactions").select("*", { count: "exact", head: true }),
    supabase.from("inventory_allocations").select("id, quantity, shipping_order_line_id").in("shipping_order_line_id", lineIds),
    supabase.from("inventory_transactions").select("bucket, delta"),
    supabase.from("container_lines").select("id, on_order_qty, received_qty"),
  ]);
  const inventoryByBucket = (inventoryRows ?? []).reduce((totals, row) => {
    const bucket = String(row.bucket ?? "UNKNOWN");
    totals[bucket] = number(totals[bucket]) + number(row.delta);
    return totals;
  }, {});
  const canonicalFulfilled = (lines ?? []).filter((line) => line.shipping_order_id === TARGET.canonicalOrderId && line.fulfillment_status === "FULFILLED");
  return {
    activeParentCount: active.length,
    activeParentId: active[0]?.id ?? null,
    lines: (lines ?? []).map((line) => line),
    protected: {
      fulfillmentCount,
      shipmentCount,
      transactionCount,
      allocationRows: allocations ?? [],
      inventoryByBucket,
      containerCount: (containerRows ?? []).length,
      containerOnOrder: (containerRows ?? []).reduce((sum, row) => sum + number(row.on_order_qty), 0),
      containerReceived: (containerRows ?? []).reduce((sum, row) => sum + number(row.received_qty), 0),
    },
    canonicalSummary: { ordered: canonicalFulfilled.length, shipped: canonicalFulfilled.reduce((sum, line) => sum + number(line.fulfilled_qty), 0), remaining: 0 },
  };
}

await main();