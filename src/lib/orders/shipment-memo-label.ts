/**
 * Produces a human-recognizable shipment label for QuickBooks internal memos.
 * This is presentation-only; it must never be used to resolve products or
 * change fulfillment, inventory, or customer-demand data.
 */
export function shipmentMemoLabel(input: {
  sku?: string | null;
  canonicalName?: string | null;
  legacyItemCode?: string | null;
}) {
  const sku = String(input.sku ?? "").trim().replace(/\s+/g, " ");
  const canonicalName = String(input.canonicalName ?? "").trim().replace(/\s+/g, " ");
  const legacyItemCode = String(input.legacyItemCode ?? "").trim().replace(/\s+/g, " ");

  // Some legacy products use a warehouse-only numeric SKU (for example,
  // 000173) while their canonical name begins with the sales model (4PXL-10).
  // Sales staff need the latter in QBO memos.
  if (/^\d+$/.test(sku) && canonicalName) {
    const model = canonicalName.match(/\b[A-Z]*\d[A-Z0-9]*(?:-[A-Z0-9]+)+\b/i)?.[0];
    return model ?? canonicalName;
  }

  return sku || legacyItemCode || canonicalName || "Mapped item";
}
