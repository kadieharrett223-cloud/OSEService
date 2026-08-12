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
    const leftEta = getContainerEta(left).etaDate;
    const rightEta = getContainerEta(right).etaDate;

    const leftTime = leftEta ? new Date(leftEta).getTime() : Number.MAX_SAFE_INTEGER;
    const rightTime = rightEta ? new Date(rightEta).getTime() : Number.MAX_SAFE_INTEGER;

    if (leftTime !== rightTime) return leftTime - rightTime;
    return (left.container_number ?? "").localeCompare(right.container_number ?? "");
  });
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
