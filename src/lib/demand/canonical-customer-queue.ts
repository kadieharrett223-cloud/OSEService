import { mergeOpenCustomerDemand, type CustomerDemandRow } from "./customer-list-demand";

export type CanonicalCustomerQueueRow = CustomerDemandRow & {
  lineId: string;
  logicalDemandKey: string;
  firstPaymentAt: string | null;
  invoiceDate: string | null;
  priorityDate: string | null;
  priorityDateSource: "FIRST_PAYMENT" | "INVOICE_NUMBER";
  orderCreatedAt: string | null;
  storedPosition: number | null;
  excludedFromQueue?: boolean;
};

export type ProjectedCustomerQueueRow = CanonicalCustomerQueueRow & {
  position: string;
};

function compareQueueRows(left: CanonicalCustomerQueueRow, right: CanonicalCustomerQueueRow) {
  const leftFirstPayment = Date.parse(left.firstPaymentAt ?? "");
  const rightFirstPayment = Date.parse(right.firstPaymentAt ?? "");
  const leftHasFirstPayment = Number.isFinite(leftFirstPayment);
  const rightHasFirstPayment = Number.isFinite(rightFirstPayment);
  if (leftHasFirstPayment !== rightHasFirstPayment) return leftHasFirstPayment ? -1 : 1;
  if (leftHasFirstPayment && leftFirstPayment !== rightFirstPayment) return leftFirstPayment - rightFirstPayment;

  if (!leftHasFirstPayment) {
    const leftInvoice = Number.parseInt(left.invoice, 10);
    const rightInvoice = Number.parseInt(right.invoice, 10);
    const leftHasInvoiceNumber = Number.isFinite(leftInvoice);
    const rightHasInvoiceNumber = Number.isFinite(rightInvoice);
    if (leftHasInvoiceNumber !== rightHasInvoiceNumber) return leftHasInvoiceNumber ? -1 : 1;
    if (leftHasInvoiceNumber && leftInvoice !== rightInvoice) return leftInvoice - rightInvoice;
    if (left.invoice !== right.invoice) return left.invoice.localeCompare(right.invoice);
  }

  if (leftHasFirstPayment) {
    const leftCreatedAt = Date.parse(left.orderCreatedAt ?? "") || Number.MAX_SAFE_INTEGER;
    const rightCreatedAt = Date.parse(right.orderCreatedAt ?? "") || Number.MAX_SAFE_INTEGER;
    if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
  }

  return (left.storedPosition ?? Number.MAX_SAFE_INTEGER) - (right.storedPosition ?? Number.MAX_SAFE_INTEGER)
    || left.lineId.localeCompare(right.lineId);
}

/**
 * The display-only Customer List queue. Stored line positions remain compatibility metadata;
 * canonical open demand, merged by invoice, is the authoritative display population. Priority is
 * the actual first payment when known, otherwise the invoice number in ascending order.
 */
export function projectCanonicalCustomerQueue<T extends CanonicalCustomerQueueRow>(rows: T[]): Array<T & { position: string }> {
  const merged = mergeOpenCustomerDemand(rows.filter((row) => !row.excludedFromQueue));
  let nextPosition = 1;

  return merged
    .sort(compareQueueRows)
    .map((row) => {
      const quantity = Math.max(1, Number(row.openQty ?? 0));
      const position = quantity > 1 ? `${nextPosition}-${nextPosition + quantity - 1}` : String(nextPosition);
      nextPosition += quantity;
      return { ...row, position };
    });
}

/** Assigns one queue sequence to all raw product records with the same operational product key. */
export function projectCanonicalCustomerQueuesByProductKey<T extends CanonicalCustomerQueueRow>(
  rows: T[],
  productKeyForRow: (row: T) => string,
): Array<T & { position: string }> {
  const rowsByProductKey = new Map<string, T[]>();
  for (const row of rows) {
    const productKey = productKeyForRow(row);
    rowsByProductKey.set(productKey, [...(rowsByProductKey.get(productKey) ?? []), row]);
  }
  return [...rowsByProductKey.values()].flatMap((productRows) => projectCanonicalCustomerQueue(productRows));
}
