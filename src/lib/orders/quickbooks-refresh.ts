/**
 * Decides what re-entering a QuickBooks invoice should change on an existing order.
 *
 * Kept free of database access so the rules — above all "never touch a line that already shipped"
 * — can be tested directly.
 */

export type RefreshInvoiceLine = {
  id: string;
  qbo_line_id?: string | null;
  product_id?: string | null;
  ordered_qty?: number | null;
  qbo_sku?: string | null;
  source_description?: string | null;
};

export type RefreshOrderLine = {
  id: string;
  qbo_invoice_line_id?: string | null;
  product_id?: string | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
};

export type RefreshPlan = {
  updates: Array<{ lineId: string; ordered_qty: number; approved_qty: number; approval_status: string; product_id: string | null }>;
  inserts: Array<{ qboInvoiceLineId: string; productId: string; orderedQty: number; qboSku: string | null; qboLineId: string | null }>;
  skippedShipped: string[];
  skippedUnmapped: string[];
  removals: Array<{ lineId: string; productId: string | null }>;
  productIds: string[];
};

export type InvoiceOrderResolution =
  | { action: "refresh"; orderId: string }
  | { action: "create" };

/** An invoice already in the system is always reused, so entering it can never create a duplicate. */
export function resolveInvoiceOrder(existingOrder: { id: string } | null | undefined): InvoiceOrderResolution {
  return existingOrder?.id ? { action: "refresh", orderId: existingOrder.id } : { action: "create" };
}

/** Match QBO's deleted-item variants to the corresponding live product alias. */
export function qboSkuCandidates(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return [] as string[];

  const candidates = [raw.toUpperCase()];
  let liveSku = raw
    .replace(/\s*\(deleted[^)]*\)\s*$/i, "")
    .trim()
    .toUpperCase();
  if (liveSku && liveSku !== candidates[0]) candidates.push(liveSku);

  while (/[-\s]1$/.test(liveSku)) {
    liveSku = liveSku.replace(/[-\s]1$/, "").trim();
    if (liveSku && !candidates.includes(liveSku)) candidates.push(liveSku);
  }
  if (/-PKG$/.test(liveSku)) {
    liveSku = liveSku.replace(/-PKG$/, "").trim();
    if (liveSku && !candidates.includes(liveSku)) candidates.push(liveSku);
  }
  return candidates;
}

/** Resolve only exact, already-approved SKU aliases; this never guesses a product. */
export function resolveKnownQboProductId(
  qboSku: string | null | undefined,
  productIdByAlias: Map<string, string>,
  existingProductId: string | null | undefined = null,
  itemIdentityChanged = false,
) {
  const aliasProductId = qboSkuCandidates(qboSku)
    .map((candidate) => productIdByAlias.get(candidate))
    .find(Boolean) ?? null;
  return itemIdentityChanged ? aliasProductId : existingProductId ?? aliasProductId;
}

export function isNonInventoryQuickbooksLine(line: { qbo_sku?: string | null; source_description?: string | null }) {
  const sku = String(line.qbo_sku ?? "").trim().toLowerCase();
  const description = String(line.source_description ?? "").trim().toLowerCase();
  return sku === "note"
    || sku.startsWith("note:")
    || sku === "inspection"
    || /discount|shipping|freight|delivery|sales tax|tax adjustment|\bservice\b|\binstall(?:ation)?\b/.test(`${sku} ${description}`);
}

export function planQuickbooksOrderRefresh(
  invoiceLines: RefreshInvoiceLine[],
  orderLines: RefreshOrderLine[],
  productIdByAlias: Map<string, string>,
): RefreshPlan {
  const existingByInvoiceLine = new Map(orderLines.map((line) => [line.qbo_invoice_line_id ?? "", line]));
  const plan: RefreshPlan = { updates: [], inserts: [], skippedShipped: [], skippedUnmapped: [], removals: [], productIds: [] };
  const productIds = new Set<string>();

  for (const invoiceLine of invoiceLines) {
    if (isNonInventoryQuickbooksLine(invoiceLine)) continue;
    const rawOrderedQty = Number(invoiceLine.ordered_qty ?? Number.NaN);
    if (Number.isFinite(rawOrderedQty) && rawOrderedQty <= 0) continue;
    const productId = resolveKnownQboProductId(invoiceLine.qbo_sku, productIdByAlias, invoiceLine.product_id);
    const orderedQty = rawOrderedQty > 0 ? rawOrderedQty : 1;
    const existing = existingByInvoiceLine.get(invoiceLine.id);

    if (existing) {
      // Shipped history is authoritative and must never be rewritten by a refresh.
      if (Number(existing.fulfilled_qty ?? 0) > 0) {
        plan.skippedShipped.push(existing.id);
        continue;
      }
      const resolvedProductId = productId ?? existing.product_id ?? null;
      // A missing mapping on a refreshed QBO row is not evidence that the
      // customer stopped buying the item. Preserve an existing product link
      // (and therefore its Customer List obligation) until the QBO line is
      // actually removed from the invoice or a user deliberately remaps it.
      if (!productId && !existing.product_id) {
        plan.skippedUnmapped.push(invoiceLine.id);
        continue;
      }
      plan.updates.push({
        lineId: existing.id,
        ordered_qty: orderedQty,
        approved_qty: orderedQty,
        approval_status: "APPROVED",
        product_id: resolvedProductId,
      });
      if (existing.product_id) productIds.add(existing.product_id);
      if (resolvedProductId) productIds.add(resolvedProductId);
      continue;
    }

    if (!productId) {
      plan.skippedUnmapped.push(invoiceLine.id);
      continue;
    }

    plan.inserts.push({
      qboInvoiceLineId: invoiceLine.id,
      productId,
      orderedQty,
      qboSku: invoiceLine.qbo_sku ?? null,
      qboLineId: invoiceLine.qbo_line_id ?? null,
    });
    productIds.add(productId);
  }

  const currentInvoiceLineIds = new Set(invoiceLines.map((line) => line.id));
  for (const orderLine of orderLines) {
    if (!orderLine.qbo_invoice_line_id || currentInvoiceLineIds.has(orderLine.qbo_invoice_line_id)) continue;
    if (Number(orderLine.fulfilled_qty ?? 0) > 0) {
      plan.skippedShipped.push(orderLine.id);
      continue;
    }
    plan.removals.push({ lineId: orderLine.id, productId: orderLine.product_id ?? null });
    if (orderLine.product_id) productIds.add(orderLine.product_id);
  }

  plan.productIds = Array.from(productIds);
  return plan;
}
