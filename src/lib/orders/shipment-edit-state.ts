export type ShipmentEditOrderLine = {
  id: string;
  sku: string;
  productName: string | null;
  orderedQty?: number;
  approvedQty: number;
  fulfilledQty: number;
};

export type ShipmentEditSavedLine = {
  shipping_order_line_id: string;
  quantity: number;
};

export type ShipmentEditLineState = ShipmentEditOrderLine & {
  currentQty: number;
  maxQty: number;
  checked: boolean;
};

/**
 * Reconstructs the editor from persisted shipment-line IDs. Current SKU, mapping, stock, and
 * remaining quantity cannot decide whether a line was already in this shipment.
 */
export function buildShipmentEditLineState(
  orderLines: ShipmentEditOrderLine[],
  savedShipmentLines: ShipmentEditSavedLine[],
) {
  const savedQtyByLine = new Map<string, number>();
  for (const savedLine of savedShipmentLines) {
    savedQtyByLine.set(savedLine.shipping_order_line_id, (savedQtyByLine.get(savedLine.shipping_order_line_id) ?? 0) + Math.max(0, savedLine.quantity));
  }

  return orderLines
    .map((line) => {
      const currentQty = savedQtyByLine.get(line.id) ?? 0;
      const remainingOutsideShipment = Math.max(0, Math.max(line.approvedQty, line.orderedQty ?? 0) - line.fulfilledQty);
      return {
        ...line,
        currentQty,
        maxQty: currentQty + remainingOutsideShipment,
        checked: currentQty > 0,
      };
    })
    .filter((line) => line.maxQty > 0 || line.checked);
}
