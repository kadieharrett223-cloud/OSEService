import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const TARGET = {
  invoice: "11811",
  orderId: "f231dd00-57be-48ce-a9ab-f9b1e92d59a3",
  lineId: "d24b21e9-d206-4fd4-ac77-eba9a4de278d",
  sourceProductId: "5340352c-1b5b-42a8-8fda-ba4b8ecdf799",
  targetProductId: "983f6e4b-596b-4e30-95ab-ad12b042f1ca",
  mappedQboSku: "4P-4032XL",
};
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function loadState() {
  const { data: line, error } = await db
    .from("shipping_order_lines")
    .select("id,shipping_order_id,product_id,legacy_item_code,legacy_matched_item_code,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,inventory_allocations(id),fulfillments(id),order_shipment_lines(id)")
    .eq("id", TARGET.lineId)
    .single();
  if (error) throw new Error(`Line read failed: ${error.message}`);
  return line;
}

function assertEligible(line) {
  if (line.shipping_order_id !== TARGET.orderId || line.product_id !== TARGET.sourceProductId) throw new Error("Unexpected source order or product; refusing correction.");
  if (String(line.legacy_item_code ?? "").toUpperCase() !== "4032S") throw new Error("Unexpected source code; refusing correction.");
  if (Number(line.fulfilled_qty ?? 0) !== 0 || (line.fulfillments ?? []).length || (line.order_shipment_lines ?? []).length) throw new Error("Fulfillment evidence exists; refusing to change product identity.");
  if ((line.inventory_allocations ?? []).length) throw new Error("An active inventory allocation exists; refusing to change product identity.");
}

async function recalculateQueuePositions(productIds) {
  const { data: lines, error } = await db
    .from("shipping_order_lines")
    .select("id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,queue_position_start,queue_position_count,queue_position_override,shipping_orders(first_payment_at,created_at,duplicate_of_order_id)")
    .in("product_id", productIds);
  if (error) throw new Error(`Queue read failed: ${error.message}`);

  let linesUpdated = 0;
  for (const productId of productIds) {
    const activeLines = (lines ?? [])
      .filter((line) => line.product_id === productId
        && !line.shipping_orders?.duplicate_of_order_id
        && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase())
        && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase())
        && Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0))
      .sort((left, right) => {
        const leftPaid = Date.parse(String(left.shipping_orders?.first_payment_at ?? ""));
        const rightPaid = Date.parse(String(right.shipping_orders?.first_payment_at ?? ""));
        if (Number.isFinite(leftPaid) !== Number.isFinite(rightPaid)) return Number.isFinite(leftPaid) ? -1 : 1;
        if (Number.isFinite(leftPaid) && leftPaid !== rightPaid) return leftPaid - rightPaid;
        return String(left.shipping_orders?.created_at ?? "").localeCompare(String(right.shipping_orders?.created_at ?? "")) || left.id.localeCompare(right.id);
      });
    let position = 1;
    for (const line of activeLines) {
      const quantity = Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0);
      if (line.queue_position_start !== position || line.queue_position_count !== quantity) {
        const { error: updateError } = await db.from("shipping_order_lines").update({ queue_position_start: position, queue_position_count: quantity }).eq("id", line.id);
        if (updateError) throw new Error(`Queue update failed: ${updateError.message}`);
        linesUpdated += 1;
      }
      position += quantity;
    }
  }
  return { productsUpdated: productIds.length, linesUpdated };
}

async function main() {
  const before = await loadState();
  if (VERIFY) {
    if (before.shipping_order_id !== TARGET.orderId || before.product_id !== TARGET.targetProductId || before.legacy_matched_item_code !== TARGET.mappedQboSku) throw new Error("Post-correction product identity validation failed.");
    if (Number(before.fulfilled_qty ?? 0) !== 0 || (before.fulfillments ?? []).length || (before.order_shipment_lines ?? []).length || (before.inventory_allocations ?? []).length) throw new Error("Protected fulfillment or allocation state changed.");
    const { data: auditRows, error: auditError } = await db.from("audit_log")
      .select("action,details,created_at")
      .eq("entity_id", TARGET.lineId)
      .eq("action", "ORDER_LINE_PRODUCT_REASSIGNED")
      .order("created_at", { ascending: false })
      .limit(1);
    if (auditError || !auditRows?.length) throw new Error(`Audit validation failed: ${auditError?.message ?? "No correction audit entry found."}`);
    console.log(JSON.stringify({ mode: "VERIFY", invoice: TARGET.invoice, line: before, audit: auditRows[0], inventoryChanged: false, fulfillmentChanged: false }, null, 2));
    return;
  }
  assertEligible(before);
  if (!APPLY) {
    console.log(JSON.stringify({ mode: "DRY_RUN", invoice: TARGET.invoice, target: TARGET, before, inventoryChanged: false, fulfillmentChanged: false }, null, 2));
    return;
  }

  const { error: updateError } = await db
    .from("shipping_order_lines")
    .update({ product_id: TARGET.targetProductId, legacy_matched_item_code: TARGET.mappedQboSku })
    .eq("id", TARGET.lineId)
    .eq("product_id", TARGET.sourceProductId);
  if (updateError) throw new Error(`Product remap failed: ${updateError.message}`);

  const { error: auditError } = await db.from("audit_log").insert({
    entity_type: "shipping_order_line",
    entity_id: TARGET.lineId,
    action: "ORDER_LINE_PRODUCT_REASSIGNED",
    details: {
      mode: "CHRIS_MEEHAN_11811_ONLY",
      invoice: TARGET.invoice,
      orderId: TARGET.orderId,
      previousProductId: TARGET.sourceProductId,
      nextProductId: TARGET.targetProductId,
      qboSku: TARGET.mappedQboSku,
      rationale: "Customer confirmed the actual item sold was 4032XL; historical 4032S mapping was incorrect.",
      inventoryChanged: false,
      fulfillmentChanged: false,
    },
  });
  if (auditError) throw new Error(`Audit write failed: ${auditError.message}`);

  const queue = await recalculateQueuePositions([TARGET.sourceProductId, TARGET.targetProductId]);

  const after = await loadState();
  if (after.product_id !== TARGET.targetProductId || after.legacy_matched_item_code !== TARGET.mappedQboSku) throw new Error("Post-correction product identity validation failed.");
  if (Number(after.fulfilled_qty ?? 0) !== 0 || (after.fulfillments ?? []).length || (after.order_shipment_lines ?? []).length || (after.inventory_allocations ?? []).length) throw new Error("Protected fulfillment or allocation state changed.");
  console.log(JSON.stringify({ mode: "APPLY", invoice: TARGET.invoice, before, after, queue, inventoryChanged: false, fulfillmentChanged: false }, null, 2));
}

await main();