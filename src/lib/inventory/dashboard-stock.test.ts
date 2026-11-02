import { describe, expect, it } from "vitest";
import { dashboardStockSummary } from "./dashboard-stock";

describe("dashboard stock owners", () => {
  it("excludes positive and negative shadow ledgers without losing real stock or standalone products", () => {
    const products = [{ id: "owner", sku: "000009" }, { id: "shadow", sku: "2PCFHD-15" }, { id: "other", sku: "STAND" }];
    const routes = [
      { product_id: "owner", stock_product_id: "owner", operational_key: "LIFT" },
      { product_id: "shadow", stock_product_id: "owner", operational_key: "LIFT" },
      { product_id: "other", stock_product_id: "other", operational_key: "STAND" },
    ];
    for (const obsolete of [94, -20]) {
      expect(dashboardStockSummary(products, [
        { product_id: "owner", bucket: "ON_FLOOR", delta: 3 },
        { product_id: "shadow", bucket: "ON_FLOOR", delta: obsolete },
        { product_id: "other", bucket: "ON_FLOOR", delta: 7 },
      ], routes)).toEqual({ onFloorInventory: 10, availableInventory: 10, lowOutOfStock: 1 });
    }
  });
  it("groups multiple valid owners of a reviewed identity for the low-stock count", () => {
    expect(dashboardStockSummary([{ id: "a", sku: "000013" }, { id: "b", sku: "000235" }], [
      { product_id: "a", bucket: "ON_FLOOR", delta: 4 }, { product_id: "b", bucket: "ON_FLOOR", delta: 4 },
    ], [{ product_id: "a", stock_product_id: "a", operational_key: "4PC6" }, { product_id: "b", stock_product_id: "b", operational_key: "4PC6" }])).toEqual({ onFloorInventory: 8, availableInventory: 8, lowOutOfStock: 0 });
  });
  it("refuses to substitute partial routing totals", () => {
    expect(() => dashboardStockSummary([{ id: "missing", sku: "LIFT" }], [], [])).toThrow(/routing is incomplete/);
  });
});
