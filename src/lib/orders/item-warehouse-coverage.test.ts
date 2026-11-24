import { expect, it } from "vitest";
import { itemWarehouseCoverage } from "./item-warehouse-coverage";

it("does not count one partially covered physical line twice across repeated invoice items", () => {
  const result = itemWarehouseCoverage([
    { key: "invoice-row-1", lineId: "physical-line", needed: 1, warehouseQty: 1 },
    { key: "invoice-row-2", lineId: "physical-line", needed: 1, warehouseQty: 1 },
    { key: "another-line", lineId: "separate-line", needed: 2, warehouseQty: 2 },
    { key: "container-only", lineId: "incoming-line", needed: 1, warehouseQty: 0 },
  ]);
  expect([...result.values()]).toEqual([1, 0, 2, 0]);
});
