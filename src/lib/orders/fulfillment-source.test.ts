import { describe, expect, it } from "vitest";
import { formatSavedFulfillmentSource, normalizeFulfillmentSource, shouldCreateWarehouseReservation, shouldMoveWarehouseInventory } from "./fulfillment-source";

describe("fulfillment source safety rules", () => {
  it("treats Warehouse/Floor as the only inventory-moving source", () => {
    expect(normalizeFulfillmentSource("FLOOR")).toBe("WAREHOUSE");
    expect(shouldMoveWarehouseInventory("WAREHOUSE")).toBe(true);
    expect(shouldMoveWarehouseInventory("FLOOR")).toBe(true);
    expect(shouldMoveWarehouseInventory("DROPSHIP")).toBe(false);
    expect(shouldMoveWarehouseInventory("OTHER")).toBe(false);
  });

  it("creates reservations only for Warehouse assignment", () => {
    expect(shouldCreateWarehouseReservation("WAREHOUSE")).toBe(true);
    expect(shouldCreateWarehouseReservation("DROPSHIP")).toBe(false);
    expect(shouldCreateWarehouseReservation("OTHER")).toBe(false);
    expect(shouldCreateWarehouseReservation(null)).toBe(false);
  });

  it("labels saved external fulfillment without implying a warehouse allocation", () => {
    expect(formatSavedFulfillmentSource("DROPSHIP", "Ebay")).toBe("Dropship · Ebay");
    expect(formatSavedFulfillmentSource("OTHER", null)).toBe("Other fulfillment");
    expect(formatSavedFulfillmentSource("WAREHOUSE", null)).toBeNull();
  });
});
