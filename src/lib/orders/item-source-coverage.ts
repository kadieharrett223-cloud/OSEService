import type { CoverageAllocation, LineCoverage } from "@/lib/fulfillment/suggested-allocation";

/** Split one physical obligation's forecast across its visible invoice rows exactly once. */
export function itemSourceCoverage(items: Array<{ key: string; lineId: string; needed: number; coverage: LineCoverage | null }>) {
  const budgets = new Map<string, CoverageAllocation[]>();
  const result = new Map<string, LineCoverage>();
  for (const item of items) {
    if (!item.coverage) continue;
    const budget = budgets.get(item.lineId) ?? item.coverage.allocations.map(a => ({ ...a }));
    budgets.set(item.lineId, budget);
    let needed = Math.max(0, item.needed);
    const allocations: CoverageAllocation[] = [];
    for (const source of budget) {
      const quantity = Math.min(needed, source.quantity);
      if (quantity <= 0) continue;
      allocations.push({ ...source, quantity });
      source.quantity -= quantity;
      needed -= quantity;
    }
    const total = (source: string) => allocations.filter(a => a.sourceType === source).reduce((sum, a) => sum + a.quantity, 0);
    const warehouseQty = total("WAREHOUSE"), incomingQty = total("CONTAINER");
    const pending = needed > 0 || allocations.some(a => a.sourceType === "UNASSIGNED" || (a.sourceType === "CONTAINER" && !a.etaDate));
    const latest = allocations.filter(a => a.etaDate).sort((a, b) => b.etaDate!.localeCompare(a.etaDate!))[0];
    result.set(item.key, { ...item.coverage, line: { ...item.coverage.line, remaining_qty: Math.max(0, item.needed) }, allocations,
      warehouseQty, incomingQty, coveredQty: warehouseQty + incomingQty, unassignedQty: total("UNASSIGNED") + needed,
      completeEtaDate: pending ? null : latest?.etaDate ?? null,
      completeEtaType: pending ? "NONE" : latest?.etaType ?? (warehouseQty > 0 ? "AVAILABLE_NOW" : "NONE") });
  }
  return result;
}
