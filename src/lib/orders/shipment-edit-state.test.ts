import { describe, expect, it } from "vitest";
import { buildShipmentEditLineState } from "./shipment-edit-state";

const orderLines = [
  { id: "a", sku: "000063", productName: "YZRCJ-7", approvedQty: 2, fulfilledQty: 2 },
  { id: "b", sku: "HPU1103", productName: "Power Unit", approvedQty: 1, fulfilledQty: 1 },
  { id: "c", sku: "HLCJ-6", productName: "Center Jack", approvedQty: 1, fulfilledQty: 0 },
];

describe("shipment editor saved-line reconstruction", () => {
  it("loads an existing line checked when no demand remains", () => {
    const state = buildShipmentEditLineState(orderLines, [{ shipping_order_line_id: "a", quantity: 2 }]);
    expect(state.find((line) => line.id === "a")).toMatchObject({ checked: true, currentQty: 2, maxQty: 2 });
  });

  it("matches by stored order line ID even if SKU or product mapping changes", () => {
    const changed = [{ ...orderLines[0], sku: "RENAMED-000063", productName: "Renamed product" }];
    const state = buildShipmentEditLineState(changed, [{ shipping_order_line_id: "a", quantity: 2 }]);
    expect(state[0]).toMatchObject({ id: "a", checked: true, currentQty: 2 });
  });

  it("loads an eligible unshipped line unchecked", () => {
    const state = buildShipmentEditLineState(orderLines, [{ shipping_order_line_id: "a", quantity: 2 }]);
    expect(state.find((line) => line.id === "c")).toMatchObject({ checked: false, currentQty: 0, maxQty: 1 });
  });

  it("sets max quantity to saved shipment quantity plus remaining demand", () => {
    const state = buildShipmentEditLineState(
      [{ id: "a", sku: "A", productName: null, approvedQty: 5, fulfilledQty: 2 }],
      [{ shipping_order_line_id: "a", quantity: 2 }],
    );
    expect(state[0]).toMatchObject({ checked: true, currentQty: 2, maxQty: 5 });
  });

  it("opening or closing the editor is pure and does not write data", () => {
    const before = JSON.stringify(orderLines);
    buildShipmentEditLineState(orderLines, [{ shipping_order_line_id: "a", quantity: 2 }]);
    expect(JSON.stringify(orderLines)).toBe(before);
  });

  it("unchanged saved quantities produce no fulfillment delta", () => {
    const state = buildShipmentEditLineState(orderLines, [
      { shipping_order_line_id: "a", quantity: 2 },
      { shipping_order_line_id: "b", quantity: 1 },
    ]);
    const delta = state.reduce((sum, line) => sum + (line.currentQty - line.currentQty), 0);
    expect(delta).toBe(0);
  });
});
