import { describe, expect, it } from "vitest";
import { getPhysicalFulfillmentTotals, isNonInventoryPhysicalLine, type PhysicalFulfillmentLine } from "./physical-fulfillment";

function line(overrides: Partial<PhysicalFulfillmentLine> = {}): PhysicalFulfillmentLine {
  return {
    product_id: "product-1",
    ordered_qty: 1,
    approved_qty: 1,
    fulfilled_qty: 0,
    fulfillment_status: "PENDING",
    products: { sku: "SKU-1", canonical_name: "Inventory item" },
    ...overrides,
  };
}

describe("physical fulfillment totals", () => {
  it("excludes note, service, freight, tax, and cancelled rows from physical demand", () => {
    const totals = getPhysicalFulfillmentTotals([
      line({ approved_qty: 2, fulfilled_qty: 2, fulfillment_status: "FULFILLED" }),
      line({ product_id: "note", legacy_item_code: "Note", approved_qty: 1, products: { sku: "Note" } }),
      line({ product_id: "service", legacy_item_code: "Install", approved_qty: 1 }),
      line({ product_id: "freight", legacy_item_code: "Freight", approved_qty: 1 }),
      line({ product_id: "tax", legacy_item_code: "Sales Tax", approved_qty: 1 }),
      line({ product_id: "cancelled", approved_qty: 1, fulfillment_status: "CANCELLED" }),
    ]);

    expect(totals).toEqual({ ordered: 2, fulfilled: 2, remaining: 0, lineCount: 1 });
  });

  it("caps fulfilled quantity at the physical ordered basis", () => {
    expect(getPhysicalFulfillmentTotals([
      line({ approved_qty: 1, ordered_qty: 1, fulfilled_qty: 3, fulfillment_status: "FULFILLED" }),
    ])).toEqual({ ordered: 1, fulfilled: 1, remaining: 0, lineCount: 1 });
  });

  it("detects note rows from sku, legacy code, or canonical name", () => {
    expect(isNonInventoryPhysicalLine(line({ legacy_item_code: "Note" }))).toBe(true);
    expect(isNonInventoryPhysicalLine(line({ products: { sku: "NOTE", canonical_name: "Memo" } }))).toBe(true);
    expect(isNonInventoryPhysicalLine(line({ products: { sku: "SKU-1", canonical_name: "Service call" } }))).toBe(true);
  });
});
