import { describe, expect, it } from "vitest";
import { getAssignedSupplySnapshot } from "@/lib/orders/item-supply-snapshot";

describe("getAssignedSupplySnapshot", () => {
  it("returns null when there are no allocations", () => {
    expect(getAssignedSupplySnapshot({ inventory_allocations: [] })).toBeNull();
  });

  it("returns warehouse snapshot when a floor allocation exists", () => {
    const snapshot = getAssignedSupplySnapshot({
      inventory_allocations: [{ quantity: 1, source_type: "FLOOR", containers: null }],
    });

    expect(snapshot).toEqual({
      comingFrom: "Warehouse",
      availability: "Reserved for this order",
      fulfillment: "Preparing",
      action: "Manage",
    });
  });

  it("returns container label when only container allocation exists", () => {
    const snapshot = getAssignedSupplySnapshot({
      inventory_allocations: [{ quantity: 2, source_type: "CONTAINER", containers: { container_number: "C-100" } }],
    });

    expect(snapshot).toEqual({
      comingFrom: "C-100",
      availability: "Reserved for this order",
      fulfillment: "Preparing",
      action: "Manage",
    });
  });

  it("ignores zero-quantity allocations", () => {
    const snapshot = getAssignedSupplySnapshot({
      inventory_allocations: [{ quantity: 0, source_type: "FLOOR", containers: null }],
    });

    expect(snapshot).toBeNull();
  });

  it("prefers warehouse label when allocations are mixed", () => {
    const snapshot = getAssignedSupplySnapshot({
      inventory_allocations: [
        { quantity: 1, source_type: "CONTAINER", containers: { container_number: "C-200" } },
        { quantity: 1, source_type: "FLOOR", containers: null },
      ],
    });

    expect(snapshot?.comingFrom).toBe("Warehouse");
  });
});
