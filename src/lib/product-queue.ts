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
  shipping_orders?: { created_at: string | null } | null;
};

const priorityRank: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
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
  const { data, error } = await supabase
    .from("shipping_order_lines")
    .select("id, product_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status, warehouse_status, priority, queue_position_override, shipping_orders(created_at)")
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

      const priorityDifference = (priorityRank[String(left.priority ?? "NORMAL").toUpperCase()] ?? 2)
        - (priorityRank[String(right.priority ?? "NORMAL").toUpperCase()] ?? 2);
      if (priorityDifference !== 0) return priorityDifference;

      const leftDate = Date.parse(String(left.shipping_orders?.created_at ?? "")) || 0;
      const rightDate = Date.parse(String(right.shipping_orders?.created_at ?? "")) || 0;
      if (leftDate !== rightDate) return leftDate - rightDate;
      return left.id.localeCompare(right.id);
    });

    let position = 1;
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

      const { error: updateError } = await supabase
        .from("shipping_order_lines")
        .update({
          queue_position_start: position,
          queue_position_count: units,
          warehouse_status: nextWarehouseStatus,
        })
        .eq("id", line.id);
      if (updateError) throw new Error(updateError.message);
      position += units;
      linesUpdated += 1;
    }

    const inactiveLines = (data ?? [])
      .map((row) => row as unknown as QueueLine)
      .filter((line) => line.product_id === productId && !isActiveQueueLine(line));
    for (const line of inactiveLines) {
      const { error: clearError } = await supabase
        .from("shipping_order_lines")
        .update({ queue_position_start: null, queue_position_count: null })
        .eq("id", line.id);
      if (clearError) throw new Error(clearError.message);
    }
  }

  return { productsUpdated: uniqueProductIds.length, linesUpdated };
}
