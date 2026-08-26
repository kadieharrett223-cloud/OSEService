import { projectCanonicalCustomerQueue } from "./canonical-customer-queue";
import { loadCanonicalCustomerQueue } from "./canonical-customer-queue-loader";

export type InvoiceDateFallbackPreviewRow = {
  customer: string;
  invoice: string;
  sku: string | null;
  firstPaymentAt: string | null;
  invoiceDate: string | null;
  previousPosition: string;
  fallbackPosition: string;
};

/** Compares display-only queue positions before and after the invoice-date fallback. */
export async function previewInvoiceDateFallbackQueue() {
  const queue = await loadCanonicalCustomerQueue();
  const lineById = new Map(queue.canonicalLines.map((line) => [line.id, line]));
  const rowsByProduct = new Map<string, typeof queue.queue>();
  for (const row of queue.queue) {
    const productId = lineById.get(row.lineId)?.product_id;
    if (!productId) continue;
    const rows = rowsByProduct.get(productId) ?? [];
    rows.push({
      ...row,
      priorityDate: row.firstPaymentAt,
      priorityDateSource: row.firstPaymentAt ? "FIRST_PAYMENT" : "ORDER_CREATED",
    });
    rowsByProduct.set(productId, rows);
  }
  const previousPositionByLineId = new Map<string, string>();
  for (const rows of rowsByProduct.values()) {
    for (const projected of projectCanonicalCustomerQueue(rows)) previousPositionByLineId.set(projected.lineId, projected.position);
  }

  const rows: InvoiceDateFallbackPreviewRow[] = queue.queue.flatMap((row) => {
    const line = lineById.get(row.lineId);
    const previousPosition = previousPositionByLineId.get(row.lineId) ?? row.position;
    if (!line || previousPosition === row.position) return [];
    return [{
      customer: line.shipping_orders?.qbo_invoices?.customers?.company_name
        ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
        ?? line.shipping_orders?.legacy_customer_name
        ?? "Customer pending",
      invoice: row.invoice,
      sku: line.products?.sku ?? null,
      firstPaymentAt: row.firstPaymentAt,
      invoiceDate: row.invoiceDate,
      previousPosition,
      fallbackPosition: row.position,
    }];
  }).sort((left, right) => (left.sku ?? "").localeCompare(right.sku ?? "") || left.invoice.localeCompare(right.invoice));

  return {
    generatedAt: new Date().toISOString(),
    activeCanonicalRows: queue.queue.length,
    changedRows: rows.length,
    affectedSkus: [...new Set(rows.map((row) => row.sku).filter((sku): sku is string => Boolean(sku)))].sort(),
    rows,
  };
}