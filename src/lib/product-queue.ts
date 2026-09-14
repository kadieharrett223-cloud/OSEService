import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { customerQueueObligationQty, isOpenCustomerQueueLine } from "@/lib/demand/product-demand";
import { canonicalProductSkuKey } from "@/lib/products/canonical-sku";

type QueueLine = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  ordered_qty?: number | null;
  fulfilled_qty: number | null;
  queue_position_start: number | null;
  queue_position_count?: number | null;
  warehouse_status: string | null;
  approval_status: string | null;
  fulfillment_status: string | null;
  priority: string | null;
  queue_position_override: number | null;
  queue_position_override_reason?: string | null;
  queue_position_override_at?: string | null;
  queue_position_override_by?: string | null;
  shipping_orders?: { created_at: string | null; first_payment_at?: string | null; duplicate_of_order_id?: string | null; cancellation_status?: string | null; review_status?: string | null; qbo_invoices?: { invoice_date: string | null; raw_payload?: { PrivateNote?: string | null } | null } | null } | null;
};

/** Legacy imports populated sequential positions without recording a real admin move. */
function hasAuditedManualPosition(line: QueueLine) {
  const position = Number(line.queue_position_override);
  return Number.isInteger(position)
    && position > 0
    && Boolean(line.queue_position_override_reason || line.queue_position_override_at || line.queue_position_override_by);
}

/** Manual overrides win, then earliest payment, then order age. */
function compareQueueLines(left: QueueLine, right: QueueLine) {
  const leftOverride = Number(left.queue_position_override);
  const rightOverride = Number(right.queue_position_override);
  const hasLeftOverride = hasAuditedManualPosition(left);
  const hasRightOverride = hasAuditedManualPosition(right);
  if (hasLeftOverride || hasRightOverride) {
    if (!hasLeftOverride) return 1;
    if (!hasRightOverride) return -1;
    if (leftOverride !== rightOverride) return leftOverride - rightOverride;
  }

  const leftPriorityDate = Date.parse(String(left.shipping_orders?.first_payment_at ?? left.shipping_orders?.qbo_invoices?.invoice_date ?? ""));
  const rightPriorityDate = Date.parse(String(right.shipping_orders?.first_payment_at ?? right.shipping_orders?.qbo_invoices?.invoice_date ?? ""));
  const leftHasPriorityDate = Number.isFinite(leftPriorityDate);
  const rightHasPriorityDate = Number.isFinite(rightPriorityDate);
  if (leftHasPriorityDate !== rightHasPriorityDate) return leftHasPriorityDate ? -1 : 1;
  if (leftHasPriorityDate && leftPriorityDate !== rightPriorityDate) return leftPriorityDate - rightPriorityDate;

  const leftDate = Date.parse(String(left.shipping_orders?.created_at ?? "")) || Number.MAX_SAFE_INTEGER;
  const rightDate = Date.parse(String(right.shipping_orders?.created_at ?? "")) || Number.MAX_SAFE_INTEGER;
  if (leftDate !== rightDate) return leftDate - rightDate;
  return left.id.localeCompare(right.id);
}

export function isActiveQueueLine(line: QueueLine) {
  return isOpenCustomerQueueLine({
    ...line,
    parent_duplicate_of_order_id: line.shipping_orders?.duplicate_of_order_id ?? null,
    parent_cancellation_status: line.shipping_orders?.cancellation_status ?? null,
    parent_review_status: line.shipping_orders?.review_status ?? null,
    parent_qbo_voided: String(line.shipping_orders?.qbo_invoices?.raw_payload?.PrivateNote ?? "").toUpperCase() === "VOIDED",
  });
}

export function calculateQueuePositions(lines: QueueLine[]) {
  const manuallyPositioned = lines
    .filter(hasAuditedManualPosition)
    .sort((left, right) => Number(left.queue_position_override) - Number(right.queue_position_override) || compareQueueLines(left, right));
  const automatic = lines.filter((line) => !manuallyPositioned.includes(line)).sort(compareQueueLines);
  const positioned: Array<{ line: QueueLine; start: number; units: number }> = [];
  let position = 1;
  const place = (line: QueueLine, start: number) => {
    const units = Math.max(0, customerQueueObligationQty(line) - Number(line.fulfilled_qty ?? 0));
    if (units <= 0) return;
    positioned.push({ line, start, units });
    position = start + units;
  };

  for (const manual of manuallyPositioned) {
    const target = Number(manual.queue_position_override);
    while (automatic.length > 0) {
      const candidate = automatic[0]!;
      const units = Math.max(0, customerQueueObligationQty(candidate) - Number(candidate.fulfilled_qty ?? 0));
      if (position + units - 1 >= target) break;
      place(automatic.shift()!, position);
    }
    place(manual, Math.max(position, target));
  }
  for (const line of automatic) place(line, position);
  return positioned;
}

/**
 * Renumbers queue positions only. Warehouse state is a separate, operator-driven decision, so
 * queue repair must never write warehouse_status or any fulfilment field.
 */
export async function recalculateProductQueuePositions(productIds: string[]) {
  const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueProductIds.length === 0) return { productsUpdated: 0, linesUpdated: 0 };

  const supabase = getSupabaseAdmin();
  // A product can have an old numeric SKU alongside its current operational SKU. Inventory
  // displays those aliases as one customer list, so persisted positions must be calculated
  // across that same canonical product identity—not independently per historical record.
  const [{ data: products, error: productsError }, { data: aliases, error: aliasesError }] = await Promise.all([
    supabase.from("products").select("id,sku"),
    supabase.from("product_aliases").select("product_id,alias"),
  ]);
  if (productsError) throw new Error(productsError.message);
  if (aliasesError) throw new Error(aliasesError.message);

  const aliasesByProductId = new Map<string, string[]>();
  for (const alias of aliases ?? []) {
    if (!alias.product_id || !alias.alias) continue;
    aliasesByProductId.set(alias.product_id, [...(aliasesByProductId.get(alias.product_id) ?? []), alias.alias]);
  }
  const productKeyById = new Map((products ?? []).map((product) => [
    product.id,
    canonicalProductSkuKey(product.sku, aliasesByProductId.get(product.id)) || product.id,
  ]));
  const targetProductKeys = new Set(uniqueProductIds.map((productId) => productKeyById.get(productId) ?? productId));
  const canonicalProductIds = (products ?? [])
    .filter((product) => targetProductKeys.has(productKeyById.get(product.id) ?? product.id))
    .map((product) => product.id);

  const { error: firstPaymentColumnError } = await supabase.from("shipping_orders").select("first_payment_at").limit(1);
  const shippingOrderPaymentField = firstPaymentColumnError ? "" : ", first_payment_at";
  const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
  const duplicateParentField = duplicateParentColumnError ? "" : ", duplicate_of_order_id";

  // Paged: a single request is capped at 1000 rows, which would leave later lines un-numbered.
  const data: unknown[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page, error } = await supabase
      .from("shipping_order_lines")
      .select(`id, product_id, ordered_qty, approved_qty, fulfilled_qty, approval_status, fulfillment_status, warehouse_status, priority, queue_position_override, queue_position_override_reason, queue_position_override_at, queue_position_override_by, queue_position_start, queue_position_count, shipping_orders(created_at${shippingOrderPaymentField}${duplicateParentField}, cancellation_status, review_status, qbo_invoices(invoice_date,raw_payload))`)
      .in("product_id", canonicalProductIds)
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (error) throw new Error(error.message);
    data.push(...(page ?? []));
    if ((page ?? []).length < 1000) break;
  }

  const linesByCanonicalProduct = new Map<string, QueueLine[]>();
  for (const rawLine of data ?? []) {
    const line = rawLine as unknown as QueueLine;
    if (line.shipping_orders?.duplicate_of_order_id) continue;
    if (!line.product_id || !isActiveQueueLine(line)) continue;
    const productKey = productKeyById.get(line.product_id) ?? line.product_id;
    const rows = linesByCanonicalProduct.get(productKey) ?? [];
    rows.push(line);
    linesByCanonicalProduct.set(productKey, rows);
  }

  let linesUpdated = 0;
  for (const productKey of targetProductKeys) {
    const lines = linesByCanonicalProduct.get(productKey) ?? [];
    const positioned = calculateQueuePositions(lines);

    const updates: Array<PromiseLike<{ error: { message: string } | null }>> = [];
    for (const { line, start, units } of positioned) {
      if (Number(line.queue_position_start ?? 0) !== start || Number(line.queue_position_count ?? 0) !== units) {
        updates.push(supabase
          .from("shipping_order_lines")
          .update({ queue_position_start: start, queue_position_count: units })
          .eq("id", line.id));
        linesUpdated += 1;
      }
    }

    const results = await Promise.all(updates);
    const updateError = results.find((result) => result.error)?.error;
    if (updateError) throw new Error(updateError.message);

    const inactiveLines = (data ?? [])
      .map((row) => row as unknown as QueueLine)
      .filter((line) => (productKeyById.get(line.product_id ?? "") ?? line.product_id) === productKey && !isActiveQueueLine(line) && line.queue_position_start != null);
    const inactiveResults = await Promise.all(inactiveLines.map((line) => supabase
      .from("shipping_order_lines")
      .update({ queue_position_start: null, queue_position_count: null })
      .eq("id", line.id)));
    const inactiveError = inactiveResults.find((result) => result.error)?.error;
    if (inactiveError) throw new Error(inactiveError.message);
  }

  return { productsUpdated: canonicalProductIds.length, linesUpdated };
}

/** Queue renumbering is positions-only so product or mapping changes cannot alter warehouse state. */
export async function recalculateProductQueues(productIds: string[]) {
  return recalculateProductQueuePositions(productIds);
}
