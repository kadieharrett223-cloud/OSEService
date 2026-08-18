import { getSupabaseAdmin } from "@/lib/supabase/admin";

type QueueLine = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  queue_position_start: number | null;
  warehouse_status: string | null;
  approval_status: string | null;
  fulfillment_status: string | null;
  priority: string | null;
  queue_position_override: number | null;
  shipping_orders?: { created_at: string | null; first_payment_at?: string | null } | null;
};

function isActiveQueueLine(line: QueueLine) {
  return Boolean(
    line.product_id
      && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase())
      && !["FULFILLED", "CANCELLED"].includes(String(line.fulfillment_status ?? "").toUpperCase()),
  );
}

export async function recalculateProductQueues(productIds: string[]) {
  const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueProductIds.length === 0) return { productsUpdated: 0, linesUpdated: 0 };

  const supabase = getSupabaseAdmin();
  const { error: firstPaymentColumnError } = await supabase.from("shipping_orders").select("first_payment_at").limit(1);
  const shippingOrderPaymentField = firstPaymentColumnError ? "" : ", first_payment_at";
  const { data, error } = await supabase
    .from("shipping_order_lines")
    .select(`id, product_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status, warehouse_status, priority, queue_position_override, shipping_orders(created_at${shippingOrderPaymentField})`)
    .in("product_id", uniqueProductIds);

  if (error) throw new Error(error.message);

  const linesByProduct = new Map<string, QueueLine[]>();
  for (const rawLine of data ?? []) {
    const line = rawLine as unknown as QueueLine;
    if (!line.product_id || !isActiveQueueLine(line)) continue;
    const rows = linesByProduct.get(line.product_id) ?? [];
    rows.push(line);
    linesByProduct.set(line.product_id, rows);
  }

  let linesUpdated = 0;
  for (const productId of uniqueProductIds) {
    const lines = (linesByProduct.get(productId) ?? []).sort((left, right) => {
      const leftOverride = Number(left.queue_position_override);
      const rightOverride = Number(right.queue_position_override);
      const hasLeftOverride = Number.isFinite(leftOverride) && leftOverride > 0;
      const hasRightOverride = Number.isFinite(rightOverride) && rightOverride > 0;
      if (hasLeftOverride || hasRightOverride) {
        if (!hasLeftOverride) return 1;
        if (!hasRightOverride) return -1;
        if (leftOverride !== rightOverride) return leftOverride - rightOverride;
      }

      const leftPaymentDate = Date.parse(String(left.shipping_orders?.first_payment_at ?? ""));
      const rightPaymentDate = Date.parse(String(right.shipping_orders?.first_payment_at ?? ""));
      const leftHasPayment = Number.isFinite(leftPaymentDate);
      const rightHasPayment = Number.isFinite(rightPaymentDate);
      if (leftHasPayment !== rightHasPayment) return leftHasPayment ? -1 : 1;
      if (leftHasPayment && leftPaymentDate !== rightPaymentDate) return leftPaymentDate - rightPaymentDate;

      const leftDate = Date.parse(String(left.shipping_orders?.created_at ?? "")) || Number.MAX_SAFE_INTEGER;
      const rightDate = Date.parse(String(right.shipping_orders?.created_at ?? "")) || Number.MAX_SAFE_INTEGER;
      if (leftDate !== rightDate) return leftDate - rightDate;
      return left.id.localeCompare(right.id);
    });

    let position = 1;
    const activeLineUpdates: Array<PromiseLike<{ error: { message: string } | null }>> = [];
    for (const line of lines) {
      const units = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
      if (units <= 0) continue;
      const currentWarehouseStatus = String(line.warehouse_status ?? "").toUpperCase();
      const nextWarehouseStatus = String(line.fulfillment_status ?? "").toUpperCase() === "FULFILLED"
        ? "FULFILLED"
        : String(line.approval_status ?? "").toUpperCase() === "HOLD"
          ? "HOLD"
          : ["ASSIGNED_TO_INBOUND", "IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(currentWarehouseStatus)
            ? currentWarehouseStatus
            : "APPROVED";

      activeLineUpdates.push(supabase
        .from("shipping_order_lines")
        .update({
          queue_position_start: position,
          queue_position_count: units,
          warehouse_status: nextWarehouseStatus,
        })
        .eq("id", line.id));
      position += units;
      linesUpdated += 1;
    }

    const activeUpdateResults = await Promise.all(activeLineUpdates);
    const activeUpdateError = activeUpdateResults.find((result) => result.error)?.error;
    if (activeUpdateError) throw new Error(activeUpdateError.message);

    const inactiveLines = (data ?? [])
      .map((row) => row as unknown as QueueLine)
      .filter((line) => line.product_id === productId && !isActiveQueueLine(line));
    const inactiveUpdateResults = await Promise.all(inactiveLines.map((line) => supabase
        .from("shipping_order_lines")
        .update({ queue_position_start: null, queue_position_count: null })
        .eq("id", line.id)));
    const inactiveUpdateError = inactiveUpdateResults.find((result) => result.error)?.error;
    if (inactiveUpdateError) throw new Error(inactiveUpdateError.message);
  }

  return { productsUpdated: uniqueProductIds.length, linesUpdated };
}
