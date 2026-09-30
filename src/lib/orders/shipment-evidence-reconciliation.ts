export type ShipmentEvidenceLine = {
  id: string;
  product_id?: string | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
};

export type ShipmentEvidenceEvent = {
  shipping_order_line_id: string;
  fulfilled_qty?: number | null;
  shipment_number?: string | null;
};

export type ShipmentEvidenceRepair = {
  lineId: string;
  productId: string | null;
  fulfilledQty: number;
  complete: boolean;
};

/**
 * A shipment record is the proof that an item left the business. The mutable
 * line summary can lag after a QBO item remap or historical import. Reconcile
 * upward only from a shipment that belongs to this order; never invent a
 * shipment and never reduce a line.
 */
export function findShipmentEvidenceRepairs(
  lines: ShipmentEvidenceLine[],
  events: ShipmentEvidenceEvent[],
  shipmentNumbers: Iterable<string | null | undefined>,
): ShipmentEvidenceRepair[] {
  const confirmedShipmentNumbers = new Set(
    [...shipmentNumbers]
      .map((shipmentNumber) => String(shipmentNumber ?? "").trim())
      .filter(Boolean),
  );
  const evidenceByLineId = new Map<string, number>();

  for (const event of events) {
    const shipmentNumber = String(event.shipment_number ?? "").trim();
    const quantity = Number(event.fulfilled_qty ?? 0);
    if (!confirmedShipmentNumbers.has(shipmentNumber) || !Number.isFinite(quantity) || quantity <= 0) continue;
    evidenceByLineId.set(
      event.shipping_order_line_id,
      (evidenceByLineId.get(event.shipping_order_line_id) ?? 0) + quantity,
    );
  }

  return lines.flatMap((line) => {
    const basis = Math.max(0, Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0));
    const current = Math.max(0, Number(line.fulfilled_qty ?? 0));
    const proven = Math.min(basis, Math.max(0, evidenceByLineId.get(line.id) ?? 0));
    if (basis <= 0 || proven <= current) return [];
    return [{
      lineId: line.id,
      productId: line.product_id ?? null,
      fulfilledQty: proven,
      complete: proven >= basis,
    }];
  });
}
