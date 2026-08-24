export type DuplicateParentHealthLine = {
  product_id?: string | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
  products?: { sku?: string | null; canonical_name?: string | null } | null;
};

export type DuplicateParentHealthOrder = {
  id: string;
  order_number?: string | null;
  source_type?: string | null;
  source_system?: string | null;
  source_invoice_id?: string | null;
  duplicate_of_order_id?: string | null;
  customerName?: string | null;
  lines: DuplicateParentHealthLine[];
};

export type DuplicateParentConflict = {
  invoice: string;
  customer: string | null;
  canonicalOrderId: string;
  staleOrderId: string;
  canonical: { ordered: number; fulfilled: number; remaining: number; products: string[] };
  stale: { ordered: number; fulfilled: number; remaining: number; products: string[] };
};

const number = (value: unknown) => Number(value ?? 0);
const normalize = (value: unknown) => String(value ?? "").trim().toUpperCase();

function summarize(lines: DuplicateParentHealthLine[]) {
  const ordered = lines.reduce((sum, line) => sum + Math.max(number(line.ordered_qty), number(line.approved_qty)), 0);
  const fulfilled = lines.reduce((sum, line) => sum + Math.min(Math.max(number(line.ordered_qty), number(line.approved_qty)), Math.max(0, number(line.fulfilled_qty))), 0);
  return {
    ordered,
    fulfilled,
    remaining: Math.max(0, ordered - fulfilled),
    productIds: [...new Set(lines.map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)))],
    products: [...new Set(lines.map((line) => line.products?.sku ?? line.products?.canonical_name ?? line.product_id).filter((product): product is string => Boolean(product)))].sort(),
  };
}

export function findActiveDuplicateParentConflicts(orders: DuplicateParentHealthOrder[]): DuplicateParentConflict[] {
  const activeBySourceInvoice = new Map<string, DuplicateParentHealthOrder[]>();
  for (const order of orders) {
    if (order.duplicate_of_order_id || !order.source_invoice_id) continue;
    activeBySourceInvoice.set(order.source_invoice_id, [...(activeBySourceInvoice.get(order.source_invoice_id) ?? []), order]);
  }

  const conflicts: DuplicateParentConflict[] = [];
  for (const siblings of activeBySourceInvoice.values()) {
    const canonical = siblings.find((order) => order.source_type === "QBO_INVOICE");
    if (!canonical) continue;
    const oldParents = siblings.filter((order) => order.source_system === "OLD_ERP" || order.source_type === "INTERNAL");
    for (const stale of oldParents) {
      const canonicalSummary = summarize(canonical.lines);
      const staleSummary = summarize(stale.lines);
      const sameCustomer = normalize(canonical.customerName) === normalize(stale.customerName);
      const matchingProducts = staleSummary.productIds.every((productId) => canonicalSummary.productIds.includes(productId));
      const safeDuplicate = sameCustomer && canonicalSummary.remaining === 0 && staleSummary.fulfilled === 0 && matchingProducts;
      if (safeDuplicate || !sameCustomer) continue;
      conflicts.push({
        invoice: String(canonical.order_number ?? stale.order_number ?? "Unknown"),
        customer: canonical.customerName ?? stale.customerName ?? null,
        canonicalOrderId: canonical.id,
        staleOrderId: stale.id,
        canonical: { ordered: canonicalSummary.ordered, fulfilled: canonicalSummary.fulfilled, remaining: canonicalSummary.remaining, products: canonicalSummary.products },
        stale: { ordered: staleSummary.ordered, fulfilled: staleSummary.fulfilled, remaining: staleSummary.remaining, products: staleSummary.products },
      });
    }
  }
  return conflicts.sort((left, right) => left.invoice.localeCompare(right.invoice) || left.staleOrderId.localeCompare(right.staleOrderId));
}