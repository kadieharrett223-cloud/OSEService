type AllocationLike = {
  quantity: number | null;
  source_type: string | null;
  containers?: {
    container_number: string | null;
  } | null;
};

type LineLike = {
  inventory_allocations?: AllocationLike[] | null;
};

export type AssignedSupplySnapshot = {
  comingFrom: string;
  availability: "Reserved for this order";
  fulfillment: "Preparing";
  action: "Manage";
};

export function getAssignedSupplySnapshot(line: LineLike | null | undefined): AssignedSupplySnapshot | null {
  const liveAllocations = (line?.inventory_allocations ?? []).filter((allocation) => Number(allocation.quantity ?? 0) > 0);
  if (liveAllocations.length === 0) return null;

  const hasWarehouseAllocation = liveAllocations.some((allocation) => allocation.source_type === "FLOOR");
  if (hasWarehouseAllocation) {
    return {
      comingFrom: "Warehouse",
      availability: "Reserved for this order",
      fulfillment: "Preparing",
      action: "Manage",
    };
  }

  const containerAllocation = liveAllocations.find((allocation) => allocation.source_type === "CONTAINER");
  if (containerAllocation) {
    return {
      comingFrom: containerAllocation.containers?.container_number ?? "Container",
      availability: "Reserved for this order",
      fulfillment: "Preparing",
      action: "Manage",
    };
  }

  return {
    comingFrom: "Assigned",
    availability: "Reserved for this order",
    fulfillment: "Preparing",
    action: "Manage",
  };
}
