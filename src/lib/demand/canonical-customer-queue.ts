import { mergeOpenCustomerDemand, type CustomerDemandRow } from "./customer-list-demand";

export type CanonicalCustomerQueueRow = CustomerDemandRow & {
  lineId: string;
  logicalDemandKey: string;
  firstPaymentAt: string | null;
  invoiceDate: string | null;
  priorityDate: string | null;
  priorityDateSource: "FIRST_PAYMENT" | "INVOICE_DATE" | "ORDER_CREATED";
  orderCreatedAt: string | null;
  storedPosition: number | null;
  excludedFromQueue?: boolean;
};

export type ProjectedCustomerQueueRow = CanonicalCustomerQueueRow & {
  position: string;
};

function compareQueueRows(left: CanonicalCustomerQueueRow, right: CanonicalCustomerQueueRow) {
  const leftPriorityDate = Date.parse(left.priorityDate ?? "");
  const rightPriorityDate = Date.parse(right.priorityDate ?? "");
  const leftHasPriorityDate = Number.isFinite(leftPriorityDate);
  const rightHasPriorityDate = Number.isFinite(rightPriorityDate);
  if (leftHasPriorityDate !== rightHasPriorityDate) return leftHasPriorityDate ? -1 : 1;
  if (leftHasPriorityDate && leftPriorityDate !== rightPriorityDate) return leftPriorityDate - rightPriorityDate;

  const leftCreatedAt = Date.parse(left.orderCreatedAt ?? "") || Number.MAX_SAFE_INTEGER;
  const rightCreatedAt = Date.parse(right.orderCreatedAt ?? "") || Number.MAX_SAFE_INTEGER;
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;

  return (left.storedPosition ?? Number.MAX_SAFE_INTEGER) - (right.storedPosition ?? Number.MAX_SAFE_INTEGER)
    || left.lineId.localeCompare(right.lineId);
}

/**
 * The display-only Customer List queue. Stored line positions remain compatibility metadata;
 * canonical open demand, merged by invoice, is the authoritative display population. Priority is
 * the actual first payment when known, otherwise the QBO invoice date, then order creation time.
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
