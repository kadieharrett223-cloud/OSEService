import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isOpenDemandLine } from "@/lib/demand/product-demand";

type QueueLine = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  queue_position_start: number | null;
  queue_position_count?: number | null;
  warehouse_status: string | null;
  approval_status: string | null;
  fulfillment_status: string | null;
  priority: string | null;
  queue_position_override: number | null;
  shipping_orders?: { created_at: string | null; first_payment_at?: string | null; duplicate_of_order_id?: string | null; cancellation_status?: string | null; review_status?: string | null } | null;
};

/** Manual overrides win, then earliest payment, then order age. */
function compareQueueLines(left: QueueLine, right: QueueLine) {
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
}

export function isActiveQueueLine(line: QueueLine) {
  return Boolean(
    line.product_id
      && String(line.shipping_orders?.review_status ?? "").toUpperCase() !== "PENDING_REVIEW"
      && isOpenDemandLine({
        ...line,
        parent_duplicate_of_order_id: line.shipping_orders?.duplicate_of_order_id ?? null,
        parent_cancellation_status: line.shipping_orders?.cancellation_status ?? null,
        parent_review_status: line.shipping_orders?.review_status ?? null,
      }),
  );
}

/**
 * Renumbers queue positions only. Warehouse state is a separate, operator-driven decision, so
 * queue repair must never write warehouse_status or any fulfilment field.
 */
export async function recalculateProductQueuePositions(productIds: string[]) {
  const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueProductIds.length === 0) return { productsUpdated: 0, linesUpdated: 0 };

  const supabase = getSupabaseAdmin();
  const { error: firstPaymentColumnError } = await supabase.from("shipping_orders").select("first_payment_at").limit(1);
  const shippingOrderPaymentField = firstPaymentColumnError ? "" : ", first_payment_at";
  const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
  const duplicateParentField = duplicateParentColumnError ? "" : ", duplicate_of_order_id";

  // Paged: a single request is capped at 1000 rows, which would leave later lines un-numbered.
  const data: unknown[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page, error } = await supabase
      .from("shipping_order_lines")
      .select(`id, product_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status, warehouse_status, priority, queue_position_override, queue_position_start, queue_position_count, shipping_orders(created_at${shippingOrderPaymentField}${duplicateParentField}, cancellation_status, review_status)`)
      .in("product_id", uniqueProductIds)
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (error) throw new Error(error.message);
    data.push(...(page ?? []));
    if ((page ?? []).length < 1000) break;
  }

  const linesByProduct = new Map<string, QueueLine[]>();
  for (const rawLine of data ?? []) {
    const line = rawLine as unknown as QueueLine;
    if (line.shipping_orders?.duplicate_of_order_id) continue;
    if (!line.product_id || !isActiveQueueLine(line)) continue;
    const rows = linesByProduct.get(line.product_id) ?? [];
    rows.push(line);
    linesByProduct.set(line.product_id, rows);
  }

  let linesUpdated = 0;
  for (const productId of uniqueProductIds) {
    const lines = (linesByProduct.get(productId) ?? []).sort(compareQueueLines);

    let position = 1;
    const updates: Array<PromiseLike<{ error: { message: string } | null }>> = [];
    for (const line of lines) {
      const units = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
      if (units <= 0) continue;

      if (Number(line.queue_position_start ?? 0) !== position || Number(line.queue_position_count ?? 0) !== units) {
        updates.push(supabase
          .from("shipping_order_lines")
          .update({ queue_position_start: position, queue_position_count: units })
          .eq("id", line.id));
        linesUpdated += 1;
      }
      position += units;
    }

    const results = await Promise.all(updates);
    const updateError = results.find((result) => result.error)?.error;
    if (updateError) throw new Error(updateError.message);

    const inactiveLines = (data ?? [])
      .map((row) => row as unknown as QueueLine)
      .filter((line) => line.product_id === productId && !isActiveQueueLine(line) && line.queue_position_start != null);
    const inactiveResults = await Promise.all(inactiveLines.map((line) => supabase
      .from("shipping_order_lines")
      .update({ queue_position_start: null, queue_position_count: null })
      .eq("id", line.id)));
    const inactiveError = inactiveResults.find((result) => result.error)?.error;
    if (inactiveError) throw new Error(inactiveError.message);
  }

  return { productsUpdated: uniqueProductIds.length, linesUpdated };
}

/** Queue renumbering is positions-only so product or mapping changes cannot alter warehouse state. */
export async function recalculateProductQueues(productIds: string[]) {
  return recalculateProductQueuePositions(productIds);
}
