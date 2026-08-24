import { describe, expect, it } from "vitest";
import { groupLogicalShipments } from "./logical-shipment";

describe("logical shipment grouping", () => {
  it("shows QBO and OLD_ERP owner shipments from one fulfillment submission as one customer shipment", () => {
    const shipments = groupLogicalShipments([
      {
        id: "qbo-shipment",
        shipment_number: "SHIP-QBO",
        idempotency_key: "order:lift-1,hpu-1,urjt-1:FULFILLMENT:qbo-parent",
        lines: [{ sku: "4PHR-9X" }, { sku: "HPU1103" }],
      },
      {
        id: "old-erp-shipment",
        shipment_number: "SHIP-ERP",
        idempotency_key: "order:lift-1,hpu-1,urjt-1:FULFILLMENT:old-erp-parent",
        lines: [{ sku: "URJT-45-1" }],
      },
    ]);

    expect(shipments).toHaveLength(1);
    expect(shipments[0]).toMatchObject({
      owner_shipment_ids: ["qbo-shipment", "old-erp-shipment"],
      lines: [{ sku: "4PHR-9X" }, { sku: "HPU1103" }, { sku: "URJT-45-1" }],
    });
  });

  it("keeps different customer fulfillment submissions separate", () => {
    const shipments = groupLogicalShipments([
      { id: "shipment-1", shipment_number: "SHIP-1", logical_shipment_id: "submission-1", lines: [{ sku: "A" }] },
      { id: "shipment-2", shipment_number: "SHIP-2", logical_shipment_id: "submission-2", lines: [{ sku: "B" }] },
    ]);

    expect(shipments).toHaveLength(2);
  });
});