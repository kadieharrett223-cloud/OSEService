import type { LineCoverage } from "@/lib/fulfillment/suggested-allocation";
import { itemSourceCoverage } from "./item-source-coverage";

/** Order lists use the same per-invoice-row coverage budget as the detail page. */
export function orderWarehouseCoverage(
  items: Array<{ remaining: number; line: { id?: string | null; warehouse_status?: string | null } | null }>,
  coverageByLineId: Map<string, LineCoverage>,
) {
  const rows = items.map((item, index) => ({ key: String(index), lineId: item.line?.id ?? `unmapped-${index}`, needed: item.remaining,
    coverage: item.line?.id ? coverageByLineId.get(item.line.id) ?? null : null }));
  const coverage = itemSourceCoverage(rows);
  let inStockQty = 0, stagedQty = 0, incomingQty = 0;
  let fullyWarehouseCovered = rows.some(row => row.needed > 0);
  for (const [index, row] of rows.entries()) {
    const warehouseQty = coverage.get(row.key)?.warehouseQty ?? 0;
    inStockQty += warehouseQty;
    incomingQty += coverage.get(row.key)?.incomingQty ?? 0;
    if (["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(items[index].line?.warehouse_status ?? "")) stagedQty += warehouseQty;
    if (row.needed > warehouseQty) fullyWarehouseCovered = false;
  }
  return { inStockQty, stagedQty, incomingQty, fullyWarehouseCovered };
}
