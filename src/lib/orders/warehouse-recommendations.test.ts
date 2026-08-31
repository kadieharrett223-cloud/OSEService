import { describe, expect, it } from "vitest";
import { recommendWarehouseOrderIds } from "./warehouse-recommendations";

describe("warehouse recommendations", () => {
  it("selects up to ten complete unreserved orders by oldest date without overcommitting floor stock", () => {
    const recommended = recommendWarehouseOrderIds({
      candidates: [
        { id: "newer", createdAt: "2026-08-03T00:00:00.000Z", requirements: [{ productId: "sku-a", quantity: 2 }] },
        { id: "oldest-out-of-stock", createdAt: "2026-08-01T00:00:00.000Z", requirements: [{ productId: "sku-b", quantity: 2 }] },
        { id: "oldest-fit", createdAt: "2026-08-02T00:00:00.000Z", requirements: [{ productId: "sku-a", quantity: 2 }] },
      ],
      floorQuantityByProduct: new Map([["sku-a", 5], ["sku-b", 1]]),
      reservedQuantityByProduct: new Map([["sku-a", 1]]),
    });

    expect(recommended).toEqual(["oldest-fit", "newer"]);
  });
});