import { customerQueueObligationQty } from "./product-demand";

type RepresentationLine = {
  id: string; product_id: string | null; qbo_invoice_line_id: string | null; source_record_id: string | null;
  approved_qty: number | null; ordered_qty?: number | null; fulfilled_qty: number | null; canonical_obligation_qty?: number | null;
  queue_position_override?: number | null;
  shipping_orders?: { source_invoice_id?: string | null } | null;
  inventory_allocations?: Array<{ allocation_status?: string | null }>;
};

/** Exact duplicate open source families share one invoice/product obligation, not two sales. */
export function withoutDuplicateInvoiceRepresentations<T extends RepresentationLine>(lines: T[], productKeyById: Map<string, string>) {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const invoice = line.shipping_orders?.source_invoice_id;
    const product = line.product_id && productKeyById.get(line.product_id);
    if (!invoice || !product) continue;
    const key = `${invoice}|${product}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const duplicates = new Set<string>();
  for (const group of groups.values()) {
    // Preserve ambiguous partial fulfillment, live commitments and manual priority.
    if (group.some(l => Number(l.fulfilled_qty ?? 0) > 0 || l.queue_position_override != null
      || l.inventory_allocations?.some(a => (a.allocation_status ?? "ALLOCATED") === "ALLOCATED"))) continue;
    const direct = group.filter(l => l.qbo_invoice_line_id);
    const legacy = group.filter(l => !l.qbo_invoice_line_id && l.source_record_id);
    if (!direct.length || direct.length !== legacy.length) continue;
    const quantities = (family: T[]) => family.map(l => customerQueueObligationQty(l)).sort((a, b) => a - b);
    const expected = quantities(direct), historical = quantities(legacy);
    if (expected.some((qty, index) => qty <= 0 || qty !== historical[index])) continue;
    for (const line of legacy) duplicates.add(line.id);
  }
  return lines.filter(line => !duplicates.has(line.id));
}
