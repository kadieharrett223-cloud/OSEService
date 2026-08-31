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

  it("prioritizes the earliest QuickBooks invoice date for unshipped ERP candidates", () => {
    const recommended = recommendWarehouseOrderIds({
      candidates: [
        { id: "entered-first", createdAt: "2026-08-01T00:00:00.000Z", quickbooksInvoiceDate: "2026-08-03", requirements: [{ productId: "sku-a", quantity: 2 }] },
        { id: "invoiced-first", createdAt: "2026-08-05T00:00:00.000Z", quickbooksInvoiceDate: "2026-08-02", requirements: [{ productId: "sku-a", quantity: 2 }] },
      ],
      floorQuantityByProduct: new Map([["sku-a", 4]]),
      reservedQuantityByProduct: new Map(),
    });

    expect(recommended).toEqual(["invoiced-first", "entered-first"]);
  });
});