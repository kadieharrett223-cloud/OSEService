export type CancellationAllocationState = {
  allocation_status?: string | null;
};

export type CancellationLineState = {
  id: string;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
  approval_status?: string | null;
  fulfillment_status?: string | null;
  inventory_allocations?: CancellationAllocationState[] | null;
};

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();

/**
 * Verifies the universal cancellation contract after the database transaction.
 * Fulfilled quantities and shipment history are intentionally preserved; every
 * remaining obligation must be closed and have no live inventory reservation.
 */
export function getOrderCancellationPostconditionErrors(
  cancellationStatus: string | null | undefined,
  lines: CancellationLineState[],
) {
  const errors: string[] = [];
  if (upper(cancellationStatus) !== "CANCELLED") errors.push("order_not_cancelled");

  for (const line of lines) {
    const ordered = Math.max(Number(line.ordered_qty ?? 0), Number(line.approved_qty ?? 0));
    const remaining = Math.max(0, ordered - Number(line.fulfilled_qty ?? 0));
    if (remaining <= 0) continue;

    if (upper(line.fulfillment_status) !== "CANCELLED" || upper(line.approval_status) !== "REMOVED") {
      errors.push(`open_line_not_cancelled:${line.id}`);
    }
    if ((line.inventory_allocations ?? []).some((allocation) => upper(allocation.allocation_status || "ALLOCATED") !== "RELEASED")) {
      errors.push(`live_allocation_not_released:${line.id}`);
    }
  }

  return errors;
}
