import { describe, expect, it } from "vitest";
import { getWarehouseDemandDisplay } from "./display-status";

describe("inventory customer demand display status", () => {
  it("keeps approved unassigned demand normal", () => {
    expect(getWarehouseDemandDisplay({ openQty: 2, warehouseStatus: "APPROVED" })).toEqual({ warehouseQty: 0, waitingQty: 2, inWarehouse: false, willCall: false });
  });

  it("marks persisted In Warehouse demand blue without changing demand", () => {
    expect(getWarehouseDemandDisplay({ openQty: 2, warehouseStatus: "IN_WAREHOUSE" })).toEqual({ warehouseQty: 2, waitingQty: 0, inWarehouse: true, willCall: false });
  });

  it("supports partial warehouse quantities", () => {
    expect(getWarehouseDemandDisplay({ openQty: 3, warehouseStatus: "IN_WAREHOUSE", warehouseQty: 2 })).toEqual({ warehouseQty: 2, waitingQty: 1, inWarehouse: true, willCall: false });
  });

  it("keeps Will Call distinguishable and supports both flags", () => {
    expect(getWarehouseDemandDisplay({ openQty: 1, warehouseStatus: "APPROVED", willCall: true }).willCall).toBe(true);
    expect(getWarehouseDemandDisplay({ openQty: 1, warehouseStatus: "IN_WAREHOUSE", willCall: true })).toMatchObject({ inWarehouse: true, willCall: true });
  });

  it("does not infer warehouse state from floor inventory", () => {
    expect(getWarehouseDemandDisplay({ openQty: 2, warehouseStatus: "APPROVED" })).toMatchObject({ warehouseQty: 0, inWarehouse: false });
  });

  it("keeps shipped demand out of the caller's open quantity", () => {
    expect(getWarehouseDemandDisplay({ openQty: 0, warehouseStatus: "FULFILLED" })).toEqual({ warehouseQty: 0, waitingQty: 0, inWarehouse: false, willCall: false });
  });
});
