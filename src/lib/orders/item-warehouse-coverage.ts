/** Repeated invoice rows must share their one physical line's warehouse coverage. */
export function itemWarehouseCoverage(items: Array<{ key: string; lineId: string; needed: number; warehouseQty: number }>) {
  const remaining = new Map<string, number>();
  const result = new Map<string, number>();
  for (const item of items) {
    const available = remaining.get(item.lineId) ?? Math.max(0, item.warehouseQty);
    const quantity = Math.min(Math.max(0, item.needed), available);
    result.set(item.key, quantity);
    remaining.set(item.lineId, Math.max(0, available - quantity));
  }
  return result;
}
