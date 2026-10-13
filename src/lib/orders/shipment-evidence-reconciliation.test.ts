import { describe, expect, it } from "vitest";
import { findShipmentEvidenceRepairs } from "./shipment-evidence-reconciliation";

describe("shipment evidence reconciliation", () => {
  it("does not resurrect a jack removed by a compensating shipment edit", () => {
    expect(findShipmentEvidenceRepairs(
      [{ id: "jack", ordered_qty: 1, fulfilled_qty: 0 }],
      [
        { shipping_order_line_id: "jack", shipment_number: "SHIP-1", fulfilled_qty: 1 },
        { shipping_order_line_id: "jack", shipment_number: "SHIP-1", fulfilled_qty: -1 },
      ], ["SHIP-1"], [],
    )).toEqual([]);
  });
  it("nets partial reversals instead of replaying the original full shipment", () => {
    expect(findShipmentEvidenceRepairs(
      [{ id: "jack", ordered_qty: 3, fulfilled_qty: 0 }],
      [
        { shipping_order_line_id: "jack", shipment_number: "SHIP-1", fulfilled_qty: 3 },
        { shipping_order_line_id: "jack", shipment_number: "SHIP-1", fulfilled_qty: -2 },
      ], ["SHIP-1"], [],
    )).toEqual([{ lineId: "jack", productId: null, fulfilledQty: 1, complete: false }]);
  });
  it("restores a line summary when its actual shipment exists", () => {
    expect(findShipmentEvidenceRepairs(
      [{ id: "jack", product_id: "jack-product", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0 }],
      [{ shipping_order_line_id: "jack", shipment_number: "SHIP-1", fulfilled_qty: 1 }],
      ["SHIP-1"],
    )).toEqual([{ lineId: "jack", productId: "jack-product", fulfilledQty: 1, complete: true }]);
  });

  it("uses the shipment-line record when a legacy ledger row has no shipment number", () => {
    expect(findShipmentEvidenceRepairs(
      [{ id: "jack", product_id: "jack-product", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0 }],
      [{ shipping_order_line_id: "jack", shipment_number: null, fulfilled_qty: 1 }],
      ["SHIP-1"],
      [{ shipping_order_line_id: "jack", quantity: 1 }],
    )).toEqual([{ lineId: "jack", productId: "jack-product", fulfilledQty: 1, complete: true }]);
  });

  it("does not treat an orphaned ledger row as a shipment", () => {
    expect(findShipmentEvidenceRepairs(
      [{ id: "jack", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0 }],
      [{ shipping_order_line_id: "jack", shipment_number: "MISSING-SHIPMENT", fulfilled_qty: 1 }],
      ["SHIP-1"],
    )).toEqual([]);
  });

  it("never changes a line beyond the invoice quantity", () => {
    expect(findShipmentEvidenceRepairs(
      [{ id: "jack", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0 }],
      [{ shipping_order_line_id: "jack", shipment_number: "SHIP-1", fulfilled_qty: 3 }],
      ["SHIP-1"],
    )).toEqual([{ lineId: "jack", productId: null, fulfilledQty: 1, complete: true }]);
  });
});
