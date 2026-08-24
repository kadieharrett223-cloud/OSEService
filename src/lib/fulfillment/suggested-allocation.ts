export type SuggestedSourceType = "WAREHOUSE" | "CONTAINER" | "UNASSIGNED";
export type SuggestedEtaType = "CONFIRMED" | "ESTIMATED" | "AVAILABLE_NOW" | "NONE";

export type SuggestedAllocationResult = {
  source_type: SuggestedSourceType;
  container_id: string | null;
  container_number: string | null;
  suggested_qty: number;
  eta_date: string | null;
  eta_type: SuggestedEtaType;
  reason: string;
};

export type OpenQueueLine = {
  id: string;
  product_id: string | null;
  remaining_qty: number;
  priority: string | null;
  queue_position_start: number | null;
  approved_at: string | null;
  created_at: string;
  has_live_allocation: boolean;
  fulfillment_source?: string | null;
  warehouse_reserved_qty?: number | null;
};

export type ProductContainerSupply = {
  container_id: string;
  container_number: string | null;
  available_qty: number;
  eta_confirmed_date: string | null;
  eta_estimated_date: string | null;
  entered_date: string | null;
};

export type SuggestedAllocationContext = {
  floorAvailableByProduct: Map<string, number>;
  queueLinesByProduct: Map<string, OpenQueueLine[]>;
  containerSupplyByProduct: Map<string, ProductContainerSupply[]>;
};

export type CoverageSourceType = "WAREHOUSE" | "CONTAINER" | "UNASSIGNED";

export type CoverageAllocation = {
  orderLineId: string;
  productId: string;
  quantity: number;
  queueStart: number | null;
  queueEnd: number | null;
  sourceType: CoverageSourceType;
  sourceId: string | null;
  sourceLabel: string;
  etaDate: string | null;
  etaType: SuggestedEtaType;
};

export type LineCoverage = {
  line: OpenQueueLine;
  allocations: CoverageAllocation[];
  coveredQty: number;
  warehouseQty: number;
  incomingQty: number;
  unassignedQty: number;
  completeEtaDate: string | null;
  completeEtaType: SuggestedEtaType;
};

export type ProductCoverageResolution = {
  productId: string;
  demand: OpenQueueLine[];
  currentSupply: number;
  incomingSupply: ProductContainerSupply[];
  allocations: CoverageAllocation[];
  lines: Map<string, LineCoverage>;
};

export type CoverageDiagnostic = {
  code: "WAREHOUSE_COVERAGE_EXCEEDS_ON_FLOOR" | "CONTAINER_COVERAGE_EXCEEDS_SUPPLY" | "NON_INVENTORY_SOURCE_CONSUMED_SUPPLY";
  severity: "WARNING" | "ERROR";
  productId: string;
  sourceId: string | null;
  expected: number;
  actual: number;
  message: string;
};

const ACTIVE_PRIORITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

function normalizePriority(priority: string | null | undefined) {
  const key = String(priority ?? "NORMAL").trim().toUpperCase();
  return ACTIVE_PRIORITY_RANK[key] ?? ACTIVE_PRIORITY_RANK.NORMAL;
}

function isoDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function getContainerEta(container: ProductContainerSupply): { etaDate: string | null; etaType: SuggestedEtaType } {
  if (container.eta_confirmed_date) {
    const parsed = new Date(container.eta_confirmed_date);
    if (!Number.isNaN(parsed.getTime())) {
      return { etaDate: isoDateOnly(parsed), etaType: "CONFIRMED" };
    }
  }

  if (container.entered_date) {
    const entered = new Date(container.entered_date);
    if (!Number.isNaN(entered.getTime())) {
      entered.setDate(entered.getDate() + 75);
      return { etaDate: isoDateOnly(entered), etaType: "ESTIMATED" };
    }
  }

  if (container.eta_estimated_date) {
    const parsed = new Date(container.eta_estimated_date);
    if (!Number.isNaN(parsed.getTime())) {
      return { etaDate: isoDateOnly(parsed), etaType: "ESTIMATED" };
    }
  }

  return { etaDate: null, etaType: "NONE" };
}

function sortQueueLines(lines: OpenQueueLine[]) {
  return [...lines].sort((left, right) => {
    const priorityRankDiff = normalizePriority(left.priority) - normalizePriority(right.priority);
    if (priorityRankDiff !== 0) return priorityRankDiff;

    const leftQueue = left.queue_position_start ?? Number.MAX_SAFE_INTEGER;
    const rightQueue = right.queue_position_start ?? Number.MAX_SAFE_INTEGER;
    if (leftQueue !== rightQueue) return leftQueue - rightQueue;

    const leftApproved = left.approved_at ? new Date(left.approved_at).getTime() : Number.MAX_SAFE_INTEGER;
    const rightApproved = right.approved_at ? new Date(right.approved_at).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftApproved !== rightApproved) return leftApproved - rightApproved;

    const leftCreated = new Date(left.created_at).getTime();
    const rightCreated = new Date(right.created_at).getTime();
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;

    return left.id.localeCompare(right.id);
  });
}

function sortContainersByEta(containers: ProductContainerSupply[]) {
  return [...containers].sort((left, right) => {
    const leftReliableEta = left.eta_confirmed_date ?? left.eta_estimated_date;
    const rightReliableEta = right.eta_confirmed_date ?? right.eta_estimated_date;
    const leftArrival = leftReliableEta ?? left.entered_date;
    const rightArrival = rightReliableEta ?? right.entered_date;
    const leftTime = leftArrival ? new Date(leftArrival).getTime() : Number.MAX_SAFE_INTEGER;
    const rightTime = rightArrival ? new Date(rightArrival).getTime() : Number.MAX_SAFE_INTEGER;

    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftEntered = left.entered_date ? new Date(left.entered_date).getTime() : Number.MAX_SAFE_INTEGER;
    const rightEntered = right.entered_date ? new Date(right.entered_date).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftEntered !== rightEntered) return leftEntered - rightEntered;
    return (left.container_number ?? "").localeCompare(right.container_number ?? "");
  });
}

function isInventoryDemand(line: OpenQueueLine) {
  const source = String(line.fulfillment_source ?? "WAREHOUSE").trim().toUpperCase();
  return source !== "DROPSHIP" && source !== "OTHER";
}

function queueRange(line: OpenQueueLine, offset: number, quantity: number) {
  if (line.queue_position_start == null) return { queueStart: null, queueEnd: null };
  const start = line.queue_position_start + offset;
  return { queueStart: start, queueEnd: start + quantity - 1 };
}

function addAllocation(
  allocations: CoverageAllocation[],
  lineAllocationsById: Map<string, CoverageAllocation[]>,
  allocation: CoverageAllocation,
) {
  allocations.push(allocation);
  const rows = lineAllocationsById.get(allocation.orderLineId) ?? [];
  rows.push(allocation);
  lineAllocationsById.set(allocation.orderLineId, rows);
}

function laterEta(left: { etaDate: string | null; etaType: SuggestedEtaType }, right: { etaDate: string | null; etaType: SuggestedEtaType }) {
  if (!left.etaDate) return right;
  if (!right.etaDate) return left;
  return new Date(right.etaDate).getTime() > new Date(left.etaDate).getTime() ? right : left;
}

export function resolveProductCoverage(productId: string, context: SuggestedAllocationContext): ProductCoverageResolution {
  const demand = sortQueueLines((context.queueLinesByProduct.get(productId) ?? [])
    .filter((line) => line.product_id === productId && line.remaining_qty > 0 && isInventoryDemand(line)));
  const currentSupply = Math.max(0, context.floorAvailableByProduct.get(productId) ?? 0);
  const incomingSupply = sortContainersByEta(context.containerSupplyByProduct.get(productId) ?? [])
    .map((container) => ({ ...container, available_qty: Math.max(0, container.available_qty) }));
  const pinnedWarehouseByLine = new Map<string, number>();
  let pinnedWarehouseQty = 0;
  for (const line of demand) {
    const pinned = Math.min(Math.max(0, line.remaining_qty), Math.max(0, Number(line.warehouse_reserved_qty ?? 0)));
    if (pinned <= 0) continue;
    pinnedWarehouseByLine.set(line.id, pinned);
    pinnedWarehouseQty += pinned;
  }
  const supply = [
    { sourceType: "WAREHOUSE" as const, sourceId: null, sourceLabel: "Warehouse", qty: Math.max(0, currentSupply - pinnedWarehouseQty), etaDate: null, etaType: "AVAILABLE_NOW" as const },
    ...incomingSupply.map((container) => {
      const eta = getContainerEta(container);
      return { sourceType: "CONTAINER" as const, sourceId: container.container_id, sourceLabel: container.container_number ?? "Container", qty: container.available_qty, etaDate: eta.etaDate, etaType: eta.etaType };
    }),
  ];
  let supplyIndex = 0;
  const allocations: CoverageAllocation[] = [];
  const lineAllocationsById = new Map<string, CoverageAllocation[]>();
  const lines = new Map<string, LineCoverage>();

  for (const line of demand) {
    const pinned = pinnedWarehouseByLine.get(line.id) ?? 0;
    if (pinned <= 0) continue;
    const range = queueRange(line, 0, pinned);
    addAllocation(allocations, lineAllocationsById, {
      orderLineId: line.id,
      productId,
      quantity: pinned,
      queueStart: range.queueStart,
      queueEnd: range.queueEnd,
      sourceType: "WAREHOUSE",
      sourceId: null,
      sourceLabel: "Warehouse",
      etaDate: null,
      etaType: "AVAILABLE_NOW",
    });
  }

  for (const line of demand) {
    const pinned = pinnedWarehouseByLine.get(line.id) ?? 0;
    let remaining = Math.max(0, line.remaining_qty - pinned);
    let offset = pinned;

    while (remaining > 0) {
      while (supplyIndex < supply.length && supply[supplyIndex].qty <= 0) supplyIndex += 1;
      const current = supply[supplyIndex];
      const take = current ? Math.min(remaining, current.qty) : remaining;
      const range = queueRange(line, offset, take);
      addAllocation(allocations, lineAllocationsById, {
        orderLineId: line.id,
        productId,
        quantity: take,
        queueStart: range.queueStart,
        queueEnd: range.queueEnd,
        sourceType: current?.sourceType ?? "UNASSIGNED",
        sourceId: current?.sourceId ?? null,
        sourceLabel: current?.sourceLabel ?? "Unassigned",
        etaDate: current?.etaDate ?? null,
        etaType: current?.etaType ?? "NONE",
      });
      if (current) current.qty -= take;
      remaining -= take;
      offset += take;
    }

    const lineAllocations = lineAllocationsById.get(line.id) ?? [];

    const completeEta = lineAllocations.reduce<{ etaDate: string | null; etaType: SuggestedEtaType }>((latest, allocation) => laterEta(latest, { etaDate: allocation.etaDate, etaType: allocation.etaType }), { etaDate: null, etaType: "NONE" });
    const warehouseQty = lineAllocations.filter((allocation) => allocation.sourceType === "WAREHOUSE").reduce((sum, allocation) => sum + allocation.quantity, 0);
    const incomingQty = lineAllocations.filter((allocation) => allocation.sourceType === "CONTAINER").reduce((sum, allocation) => sum + allocation.quantity, 0);
    const unassignedQty = lineAllocations.filter((allocation) => allocation.sourceType === "UNASSIGNED").reduce((sum, allocation) => sum + allocation.quantity, 0);
    lines.set(line.id, {
      line,
      allocations: lineAllocations,
      coveredQty: warehouseQty + incomingQty,
      warehouseQty,
      incomingQty,
      unassignedQty,
      completeEtaDate: completeEta.etaDate,
      completeEtaType: completeEta.etaType,
    });
  }

  return { productId, demand, currentSupply, incomingSupply, allocations, lines };
}

export function validateProductCoverage(resolution: ProductCoverageResolution, allDemand: OpenQueueLine[] = resolution.demand): CoverageDiagnostic[] {
  const diagnostics: CoverageDiagnostic[] = [];
  const warehouseCovered = resolution.allocations
    .filter((allocation) => allocation.sourceType === "WAREHOUSE")
    .reduce((sum, allocation) => sum + allocation.quantity, 0);
  if (warehouseCovered > resolution.currentSupply) {
    diagnostics.push({
      code: "WAREHOUSE_COVERAGE_EXCEEDS_ON_FLOOR",
      severity: "ERROR",
      productId: resolution.productId,
      sourceId: null,
      expected: resolution.currentSupply,
      actual: warehouseCovered,
      message: "Warehouse coverage exceeds ON_FLOOR supply.",
    });
  }

  for (const container of resolution.incomingSupply) {
    const covered = resolution.allocations
      .filter((allocation) => allocation.sourceType === "CONTAINER" && allocation.sourceId === container.container_id)
      .reduce((sum, allocation) => sum + allocation.quantity, 0);
    if (covered > Math.max(0, container.available_qty)) {
      diagnostics.push({
        code: "CONTAINER_COVERAGE_EXCEEDS_SUPPLY",
        severity: "ERROR",
        productId: resolution.productId,
        sourceId: container.container_id,
        expected: Math.max(0, container.available_qty),
        actual: covered,
        message: "Incoming container coverage exceeds its SKU quantity.",
      });
    }
  }

  const consumedLineIds = new Set(resolution.allocations.filter((allocation) => allocation.sourceType !== "UNASSIGNED").map((allocation) => allocation.orderLineId));
  for (const line of allDemand) {
    if (!consumedLineIds.has(line.id)) continue;
    if (!isInventoryDemand(line)) {
      diagnostics.push({
        code: "NON_INVENTORY_SOURCE_CONSUMED_SUPPLY",
        severity: "ERROR",
        productId: resolution.productId,
        sourceId: null,
        expected: 0,
        actual: Math.max(0, line.remaining_qty),
        message: "Dropship/Other demand consumed warehouse or incoming coverage.",
      });
    }
  }

  return diagnostics;
}

export function getSuggestedAllocation(orderLine: OpenQueueLine, context: SuggestedAllocationContext): SuggestedAllocationResult {
  if (!orderLine.product_id || orderLine.remaining_qty <= 0) {
    return {
      source_type: "UNASSIGNED",
      container_id: null,
      container_number: null,
      suggested_qty: 0,
      eta_date: null,
      eta_type: "NONE",
      reason: "Line is already fulfilled or does not have a mapped product.",
    };
  }

  if (orderLine.has_live_allocation) {
    return {
      source_type: "UNASSIGNED",
      container_id: null,
      container_number: null,
      suggested_qty: 0,
      eta_date: null,
      eta_type: "NONE",
      reason: "Line already has a live allocation; suggestions only apply before assignment.",
    };
  }

  const productId = orderLine.product_id;
  const queue = sortQueueLines((context.queueLinesByProduct.get(productId) ?? []).filter((line) => !line.has_live_allocation && line.remaining_qty > 0));
  const floorAvailableStart = Math.max(0, context.floorAvailableByProduct.get(productId) ?? 0);
  let floorAvailable = floorAvailableStart;

  const containerSupply = sortContainersByEta(context.containerSupplyByProduct.get(productId) ?? []).map((container) => ({
    ...container,
    available_qty: Math.max(0, container.available_qty),
  }));

  for (const queuedLine of queue) {
    const needed = Math.max(0, queuedLine.remaining_qty);
    if (needed <= 0) continue;

    if (floorAvailable >= needed) {
      floorAvailable -= needed;
      if (queuedLine.id === orderLine.id) {
        return {
          source_type: "WAREHOUSE",
          container_id: null,
          container_number: null,
          suggested_qty: needed,
          eta_date: null,
          eta_type: "AVAILABLE_NOW",
          reason: "Warehouse has enough available stock after accounting for earlier queued demand.",
        };
      }
      continue;
    }

    const firstFitIndex = containerSupply.findIndex((container) => container.available_qty >= needed);
    if (firstFitIndex >= 0) {
      const selected = containerSupply[firstFitIndex];
      selected.available_qty -= needed;

      if (queuedLine.id === orderLine.id) {
        const eta = getContainerEta(selected);
        return {
          source_type: "CONTAINER",
          container_id: selected.container_id,
          container_number: selected.container_number,
          suggested_qty: needed,
          eta_date: eta.etaDate,
          eta_type: eta.etaType,
          reason: "First incoming container with sufficient unallocated quantity for this queued line.",
        };
      }
      continue;
    }

    if (queuedLine.id === orderLine.id) {
      return {
        source_type: "UNASSIGNED",
        container_id: null,
        container_number: null,
        suggested_qty: needed,
        eta_date: null,
        eta_type: "NONE",
        reason: "No warehouse stock or single incoming container has enough available quantity yet.",
      };
    }
  }

  return {
    source_type: "UNASSIGNED",
    container_id: null,
    container_number: null,
    suggested_qty: Math.max(0, orderLine.remaining_qty),
    eta_date: null,
    eta_type: "NONE",
    reason: "Line was not found in the active queue set for this product.",
  };
}
