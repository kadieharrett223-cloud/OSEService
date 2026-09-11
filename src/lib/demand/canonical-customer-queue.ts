import { mergeOpenCustomerDemand, type CustomerDemandRow } from "./customer-list-demand";

export type CanonicalCustomerQueueRow = CustomerDemandRow & {
  lineId: string;
  logicalDemandKey: string;
  firstPaymentAt: string | null;
  invoiceDate: string | null;
  priorityDate: string | null;
  priorityDateSource: "FIRST_PAYMENT" | "INVOICE_DATE" | "INVOICE_NUMBER";
  orderCreatedAt: string | null;
  storedPosition: number | null;
  manualPosition?: number | null;
  excludedFromQueue?: boolean;
};

export type ProjectedCustomerQueueRow = CanonicalCustomerQueueRow & {
  position: string;
};

function compareQueueRows(left: CanonicalCustomerQueueRow, right: CanonicalCustomerQueueRow) {
  const leftPriorityDate = Date.parse(left.priorityDate ?? left.firstPaymentAt ?? left.invoiceDate ?? "");
  const rightPriorityDate = Date.parse(right.priorityDate ?? right.firstPaymentAt ?? right.invoiceDate ?? "");
  const leftHasPriorityDate = Number.isFinite(leftPriorityDate);
  const rightHasPriorityDate = Number.isFinite(rightPriorityDate);
  if (leftHasPriorityDate !== rightHasPriorityDate) return leftHasPriorityDate ? -1 : 1;
  if (leftHasPriorityDate && leftPriorityDate !== rightPriorityDate) return leftPriorityDate - rightPriorityDate;

  const leftInvoice = Number.parseInt(left.invoice, 10);
  const rightInvoice = Number.parseInt(right.invoice, 10);
  const leftHasInvoiceNumber = Number.isFinite(leftInvoice);
  const rightHasInvoiceNumber = Number.isFinite(rightInvoice);
  if (leftHasInvoiceNumber !== rightHasInvoiceNumber) return leftHasInvoiceNumber ? -1 : 1;
  if (leftHasInvoiceNumber && leftInvoice !== rightInvoice) return leftInvoice - rightInvoice;
  if (left.invoice !== right.invoice) return left.invoice.localeCompare(right.invoice);

  if (left.firstPaymentAt && right.firstPaymentAt) {
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
 * the actual first payment when known, otherwise the invoice creation date, then the invoice
 * number in ascending order only when neither date is available.
 */
export function projectCanonicalCustomerQueue<T extends CanonicalCustomerQueueRow>(rows: T[]): Array<T & { position: string }> {
  const merged = mergeOpenCustomerDemand(rows.filter((row) => !row.excludedFromQueue)).sort(compareQueueRows);
  const manuallyPositioned = merged
    .filter((row) => Number.isInteger(row.manualPosition) && Number(row.manualPosition) > 0)
    .sort((left, right) => Number(left.manualPosition) - Number(right.manualPosition) || compareQueueRows(left, right));
  const automatic = merged.filter((row) => !manuallyPositioned.includes(row));
  const projected: Array<T & { position: string }> = [];
  let nextPosition = 1;

  function add(row: T, start: number) {
    const quantity = Math.max(1, Number(row.openQty ?? 0));
    const position = quantity > 1 ? `${start}-${start + quantity - 1}` : String(start);
    projected.push({ ...row, position });
    nextPosition = start + quantity;
  }

  for (const manual of manuallyPositioned) {
    const target = Number(manual.manualPosition);
    while (automatic.length > 0) {
      const candidate = automatic[0]!;
      const candidateQty = Math.max(1, Number(candidate.openQty ?? 0));
      if (nextPosition + candidateQty - 1 >= target) break;
      add(automatic.shift()!, nextPosition);
    }
    add(manual, Math.max(nextPosition, target));
  }

  for (const row of automatic) add(row, nextPosition);
  return projected;
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
