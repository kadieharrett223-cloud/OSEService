import { describe, expect, it } from "vitest";
import { compareWarehouseOrderAge, recommendWarehouseOrderIds } from "./warehouse-recommendations";

describe("warehouse recommendations", () => {
  it("caps recommendations at ten and ignores newest-first input/import timestamps", () => {
    const candidates = Array.from({ length: 15 }, (_, index) => ({
      id: String(index).padStart(2, "0"), createdAt: "2026-10-13",
      quickbooksInvoiceDate: `2026-04-${String(index + 1).padStart(2, "0")}`,
      requirements: [{ productId: "lift", quantity: 1 }],
    })).reverse();
    const floor = new Map([["lift", 20]]);
    const reserved = new Map([["lift", 2]]);
    expect(recommendWarehouseOrderIds({ candidates, floorQuantityByProduct: floor, reservedQuantityByProduct: reserved }))
      .toEqual(["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);
    expect(floor.get("lift")).toBe(20);
    expect(reserved.get("lift")).toBe(2);
    expect(candidates[0].id).toBe("14");
  });

  it("falls back to creation date when the invoice date is invalid and uses a stable tie-break", () => {
    const rows = [
      { id: "z", createdAt: "2026-01-01", quickbooksInvoiceDate: "invalid" },
      { id: "a", createdAt: "2026-01-02", quickbooksInvoiceDate: "2026-01-01" },
      { id: "new", createdAt: "2026-10-13", quickbooksInvoiceDate: null },
    ];
    expect(rows.sort(compareWarehouseOrderAge).map((row) => row.id)).toEqual(["a", "z", "new"]);
  });

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
