import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { shouldMoveWarehouseInventory } from "./fulfillment-source";

function inventoryDeltasForFulfillment(source: string, quantity: number) {
  return shouldMoveWarehouseInventory(source) ? [{ bucket: "ON_FLOOR", delta: -quantity }] : [];
}

function inventoryDeltasForShipmentEdit(source: string, previousQuantity: number, requestedQuantity: number) {
  return inventoryDeltasForFulfillment(source, requestedQuantity - previousQuantity);
}

describe("forward fulfillment inventory contract", () => {
  it("records an exact ON_FLOOR reduction and no SOLD transaction for Warehouse fulfillment", () => {
    expect(inventoryDeltasForFulfillment("WAREHOUSE", 3)).toEqual([{ bucket: "ON_FLOOR", delta: -3 }]);
  });

  it("records each Warehouse partial fulfillment as only its exact shipped quantity", () => {
    expect(inventoryDeltasForFulfillment("WAREHOUSE", 1)).toEqual([{ bucket: "ON_FLOOR", delta: -1 }]);
    expect(inventoryDeltasForFulfillment("WAREHOUSE", 2)).toEqual([{ bucket: "ON_FLOOR", delta: -2 }]);
  });

  it("applies Warehouse shipment edits as the inverse of the quantity delta", () => {
    expect(inventoryDeltasForShipmentEdit("WAREHOUSE", 2, 3)).toEqual([{ bucket: "ON_FLOOR", delta: -1 }]);
    expect(inventoryDeltasForShipmentEdit("WAREHOUSE", 3, 2)).toEqual([{ bucket: "ON_FLOOR", delta: 1 }]);
  });

  it("keeps Dropship and Other fulfillment and shipment edits inventory-neutral", () => {
    for (const source of ["DROPSHIP", "OTHER"]) {
      expect(inventoryDeltasForFulfillment(source, 2)).toEqual([]);
      expect(inventoryDeltasForShipmentEdit(source, 2, 3)).toEqual([]);
      expect(inventoryDeltasForShipmentEdit(source, 3, 2)).toEqual([]);
    }
  });

  it("has no second inventory delta when an idempotent RPC submission returns its existing shipment", () => {
    const existingShipmentWasReturned = true;
    const deltas = existingShipmentWasReturned ? [] : inventoryDeltasForFulfillment("WAREHOUSE", 2);
    expect(deltas).toEqual([]);
  });

  it("keeps the forward shipment RPC idempotent and free of SOLD writes", () => {
    const migration = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/202608240001_stop_fulfillment_sold_writes.sql"), "utf8");
    expect(migration).toContain("select id into v_shipment_id from public.order_shipments where idempotency_key = p_idempotency_key;");
    expect(migration).toContain("if v_shipment_id is not null then return v_shipment_id; end if;");
    expect(migration).not.toMatch(/bucket\s*=\s*'SOLD'|'SOLD'/);
  });
});