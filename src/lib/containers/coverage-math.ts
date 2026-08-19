export type DemandLine = {
  lineId: string;
  orderId: string;
  productId: string;
  invoice: string;
  customer: string;
  sku: string;
  remainingQty: number;
  queuePosition: number | null;
  currentWarehouse: string;
  isAssigned: boolean;
  createdAt: string;
};

export type CoverageRow = DemandLine & {
  coveredQty: number;
  willMarkInWarehouse: boolean;
};

export type DemandByProduct = Record<string, DemandLine[]>;

/** Explicitly assigned lines claim container units first, then remaining demand in queue order. */
export function sortDemand(lines: DemandLine[]) {
  return [...lines].sort((left, right) => {
    if (left.isAssigned !== right.isAssigned) return left.isAssigned ? -1 : 1;
    const leftQueue = left.queuePosition ?? Number.MAX_SAFE_INTEGER;
    const rightQueue = right.queuePosition ?? Number.MAX_SAFE_INTEGER;
    if (leftQueue !== rightQueue) return leftQueue - rightQueue;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function totalDemandQty(lines: DemandLine[]) {
  return lines.reduce((sum, line) => sum + Math.max(0, line.remainingQty), 0);
}

export type ProductCoverage = {
  rows: CoverageRow[];
  coveredCustomerCount: number;
  coveredUnits: number;
  extraUnits: number;
};

/** Allocates a single product's available units across its demand, in queue order. */
export function coverProduct(lines: DemandLine[], availableQty: number): ProductCoverage {
  let capacity = Math.max(0, availableQty);
  let coveredCustomerCount = 0;
  let coveredUnits = 0;
  const rows: CoverageRow[] = [];

  for (const line of sortDemand(lines)) {
    const covered = Math.min(line.remainingQty, Math.max(0, capacity));
    capacity -= covered;
    coveredUnits += covered;

    const fullyCovered = covered > 0 && covered === line.remainingQty;
    if (fullyCovered) coveredCustomerCount += 1;

    rows.push({ ...line, coveredQty: covered, willMarkInWarehouse: fullyCovered });
  }

  return { rows, coveredCustomerCount, coveredUnits, extraUnits: Math.max(0, capacity) };
}

export function computeCoverage(demandByProduct: DemandByProduct, qtyByProduct: Record<string, number>) {
  const rows: CoverageRow[] = [];
  const eligibleLineIds = new Set<string>();
  const coveredCustomerCountByProduct: Record<string, number> = {};
  const extraUnitsByProduct: Record<string, number> = {};

  for (const [productId, lines] of Object.entries(demandByProduct)) {
    const result = coverProduct(lines, qtyByProduct[productId] ?? 0);
    coveredCustomerCountByProduct[productId] = result.coveredCustomerCount;
    extraUnitsByProduct[productId] = result.extraUnits;

    for (const row of result.rows) {
      if (row.willMarkInWarehouse) eligibleLineIds.add(row.lineId);
      rows.push(row);
    }
  }

  rows.sort((left, right) => {
    if (left.coveredQty > 0 !== right.coveredQty > 0) return left.coveredQty > 0 ? -1 : 1;
    if (left.isAssigned !== right.isAssigned) return left.isAssigned ? -1 : 1;
    const leftQueue = left.queuePosition ?? Number.MAX_SAFE_INTEGER;
    const rightQueue = right.queuePosition ?? Number.MAX_SAFE_INTEGER;
    if (leftQueue !== rightQueue) return leftQueue - rightQueue;
    return left.customer.localeCompare(right.customer);
  });

  return { rows, eligibleLineIds, coveredCustomerCountByProduct, extraUnitsByProduct };
}
