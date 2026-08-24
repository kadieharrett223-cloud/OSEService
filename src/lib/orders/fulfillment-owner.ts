export type FulfillmentOwnerSelection = {
  ownerOrderId?: string | null;
};

export type FulfillmentOwnerParent = {
  id: string;
  source_invoice_id?: string | null;
  duplicate_of_order_id?: string | null;
};

export function resolveSingleFulfillmentOwner(
  lines: FulfillmentOwnerSelection[],
  defaultOwnerOrderId: string,
) {
  const ownerOrderIds = new Set(
    lines.map((line) => line.ownerOrderId ?? defaultOwnerOrderId),
  );
  return ownerOrderIds.size === 1 ? [...ownerOrderIds][0] ?? null : null;
}

export function isActiveSameInvoiceSiblingOwner(
  pageOrderId: string,
  ownerOrderId: string,
  parents: FulfillmentOwnerParent[],
) {
  if (pageOrderId === ownerOrderId) return true;
  const pageParent = parents.find((parent) => parent.id === pageOrderId);
  const ownerParent = parents.find((parent) => parent.id === ownerOrderId);
  return Boolean(
    pageParent?.source_invoice_id
    && pageParent.source_invoice_id === ownerParent?.source_invoice_id
    && !ownerParent?.duplicate_of_order_id,
  );
}
