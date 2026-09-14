export type OrderOperationalTotals = {
  ordered: number;
  fulfilled: number;
  remaining: number;
};

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();

/** A cancelled parent is terminal and always overrides payment, stock, and line-derived workflow labels. */
export function isCancelledOrder(cancellationStatus: string | null | undefined) {
  return upper(cancellationStatus) === "CANCELLED";
}

export function cancellationAwareOperationalTotals<T extends OrderOperationalTotals>(
  totals: T,
  cancelled: boolean,
): T {
  return cancelled ? { ...totals, remaining: 0 } : totals;
}

export function cancellationAwareStatus(cancelled: boolean, operationalStatus: string) {
  return cancelled ? "Cancelled" : operationalStatus;
}
