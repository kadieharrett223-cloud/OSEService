export type CustomerDemandRow = {
  invoice: string;
  orderId: string;
  openQty: number;
  warehouseQty: number;
  waitingQty: number;
  inWarehouse: boolean;
  willCall: boolean;
  qty: number;
  approvedQty: number;
  shippedQty: number;
  invoiceOrderedQty: number | null;
  provenInvoiceShippedQty: number;
};

/** Produces one active Customer List row per invoice after authoritative shipment reconciliation. */
export function mergeOpenCustomerDemand<T extends CustomerDemandRow>(items: T[]): T[] {
  const customerDemandByInvoice = new Map<string, T>();
  for (const item of items) {
    const key = item.invoice && item.invoice !== "—"
      ? `INVOICE:${item.invoice}`.toUpperCase()
      : `ORDER:${item.orderId}`.toUpperCase();
    const existing = customerDemandByInvoice.get(key);
    if (!existing) {
      customerDemandByInvoice.set(key, { ...item });
      continue;
    }
    existing.openQty += item.openQty;
    existing.warehouseQty += item.warehouseQty;
    existing.waitingQty += item.waitingQty;
    existing.inWarehouse = existing.inWarehouse || item.inWarehouse;
    existing.willCall = existing.willCall || item.willCall;
    existing.qty = Math.max(existing.qty, item.qty);
    existing.approvedQty = Math.max(existing.approvedQty, item.approvedQty);
    existing.shippedQty += item.shippedQty;
    existing.invoiceOrderedQty = existing.invoiceOrderedQty ?? item.invoiceOrderedQty;
    existing.provenInvoiceShippedQty = Math.max(existing.provenInvoiceShippedQty, item.provenInvoiceShippedQty);
  }
  for (const item of customerDemandByInvoice.values()) {
    if (item.invoiceOrderedQty == null) continue;
    const orderedQty = Math.max(0, Number(item.invoiceOrderedQty));
    const shippedQty = Math.min(orderedQty, Math.max(0, item.shippedQty, item.provenInvoiceShippedQty));
    item.qty = orderedQty;
    item.approvedQty = orderedQty;
    item.shippedQty = shippedQty;
    item.openQty = Math.max(0, orderedQty - shippedQty);
    item.warehouseQty = Math.min(item.warehouseQty, item.openQty);
    item.waitingQty = Math.max(0, item.openQty - item.warehouseQty);
    item.inWarehouse = item.warehouseQty > 0;
  }
  return Array.from(customerDemandByInvoice.values()).filter((item) => item.openQty > 0);
}