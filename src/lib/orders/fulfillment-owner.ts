export type FulfillmentOwnerSelection = {
  ownerOrderId?: string | null;
};

export type FulfillmentOwnerParent = {
  id: string;
  source_invoice_id?: string | null;
  duplicate_of_order_id?: string | null;
};

export type LogicalFulfillmentCapacityLine = {
  id: string;
  product_id?: string | null;
  qbo_invoice_line_id?: string | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
};

export type LogicalFulfillmentSelection = {
  lineId: string;
  quantity: number;
};

function capacity(line: LogicalFulfillmentCapacityLine) {
  return Math.max(Number(line.ordered_qty ?? 0), Number(line.approved_qty ?? 0));
}

/**
 * A legacy line with exactly one current QBO product counterpart represents
 * the same customer obligation.  It must not be fulfilled a second time.
 * Ambiguous same-product invoices intentionally stay separate for review.
 */
function logicalFulfillmentKey(
  line: LogicalFulfillmentCapacityLine,
  allLines: LogicalFulfillmentCapacityLine[],
) {
  if (line.qbo_invoice_line_id) return `QBO:${line.qbo_invoice_line_id}`;
  if (!line.product_id) return `LINE:${line.id}`;
  const matchingQboLineIds = [...new Set(allLines
    .filter((candidate) => candidate.product_id === line.product_id && candidate.qbo_invoice_line_id)
    .map((candidate) => String(candidate.qbo_invoice_line_id)))];
  return matchingQboLineIds.length === 1 ? `QBO:${matchingQboLineIds[0]}` : `LINE:${line.id}`;
}

/** Returns the logical QBO obligation keys whose requested fulfillment would exceed their capacity. */
export function findLogicalFulfillmentOverages(
  allLines: LogicalFulfillmentCapacityLine[],
  selections: LogicalFulfillmentSelection[],
) {
  const linesByKey = new Map<string, LogicalFulfillmentCapacityLine[]>();
  for (const line of allLines) {
    const key = logicalFulfillmentKey(line, allLines);
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), line]);
  }
  const requestedByKey = new Map<string, number>();
  for (const selection of selections) {
    const line = allLines.find((candidate) => candidate.id === selection.lineId);
    if (!line) continue;
    const key = logicalFulfillmentKey(line, allLines);
    requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + Math.max(0, Number(selection.quantity ?? 0)));
  }

  return [...requestedByKey.entries()]
    .filter(([key, requested]) => {
      const lines = linesByKey.get(key) ?? [];
      const qboCapacity = lines
        .filter((line) => Boolean(line.qbo_invoice_line_id))
        .reduce((maximum, line) => Math.max(maximum, capacity(line)), 0);
      const allowed = qboCapacity || lines.reduce((sum, line) => sum + capacity(line), 0);
      const fulfilled = lines.reduce((sum, line) => sum + Math.max(0, Number(line.fulfilled_qty ?? 0)), 0);
      return fulfilled + requested > allowed;
    })
    .map(([key]) => key);
}

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
