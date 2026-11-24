type Allocation = {
  source_type?: string | null;
  container_id?: string | null;
  quantity?: number | null;
  allocation_status?: string | null;
};

/** Saved container quantities take precedence over stale general warehouse status. */
export function lineSourceReservations(remainingQty: number, warehouseStatus: string | null | undefined, allocations: Allocation[] = []) {
  const remaining = Math.max(0, remainingQty);
  const live = allocations.filter(a => (a.allocation_status ?? "ALLOCATED") === "ALLOCATED" && Number(a.quantity ?? 0) > 0);
  const containerReservedQuantities = live
    .filter(a => a.source_type === "CONTAINER" && a.container_id)
    .map(a => ({ container_id: a.container_id!, quantity: Math.max(0, Number(a.quantity ?? 0)) }));
  const incomingReserved = containerReservedQuantities.reduce((sum, a) => sum + a.quantity, 0);
  const floorReserved = live.filter(a => a.source_type === "FLOOR").reduce((sum, a) => sum + Number(a.quantity ?? 0), 0);
  const staged = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(warehouseStatus ?? "").toUpperCase());
  return {
    warehouse_reserved_qty: Math.min(Math.max(0, remaining - incomingReserved), staged ? remaining : floorReserved),
    container_reserved_quantities: containerReservedQuantities,
  };
}

/** Several real invoice lines can share one Customer List row and coverage budget. */
export function mergedLineSourceReservations(remainingQty: number, parts: Array<{ remainingQty: number; warehouseStatus?: string | null; allocations?: Allocation[] }>) {
  const reservations = parts.map(p => lineSourceReservations(p.remainingQty, p.warehouseStatus, p.allocations));
  const incoming = new Map<string, number>();
  for (const part of reservations) for (const pin of part.container_reserved_quantities) incoming.set(pin.container_id, (incoming.get(pin.container_id) ?? 0) + pin.quantity);
  const container_reserved_quantities = [...incoming].map(([container_id, quantity]) => ({ container_id, quantity }));
  const incomingQty = container_reserved_quantities.reduce((sum, pin) => sum + pin.quantity, 0);
  return { warehouse_reserved_qty: Math.min(Math.max(0, remainingQty - incomingQty), reservations.reduce((sum, part) => sum + part.warehouse_reserved_qty, 0)), container_reserved_quantities };
}
