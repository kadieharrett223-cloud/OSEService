import { describe, expect, it } from "vitest";
import { parentsForOrdersProjection } from "./orders-projection-preservation";

describe("Orders projection preservation", () => {
  it("keeps active same-invoice parents independent until their evidence is safely merged", () => {
    const parents = parentsForOrdersProjection([
      {
        id: "qbo-parent",
        source_invoice_id: "source-12310",
        customerListMember: true,
        archivedHistory: true,
        cancelledHistory: true,
      },
      {
        id: "old-erp-parent",
        source_invoice_id: "source-12310",
        activeDemand: 1,
        inWarehouseDemand: 1,
        partiallyFulfilledDemand: 1,
        fulfilledQuantity: 3,
        shipmentEvidence: 3,
        queuePositions: 4,
        reservations: 1,
        containerAllocations: 1,
        inventoryEvidence: 6,
      },
      { id: "retired-parent", source_invoice_id: "source-12310", duplicate_of_order_id: "qbo-parent" },
    ]);

    expect(parents.map((parent) => parent.id)).toEqual(["qbo-parent", "old-erp-parent"]);
    expect(parents[1]).toMatchObject({
      activeDemand: 1,
      inWarehouseDemand: 1,
      partiallyFulfilledDemand: 1,
      fulfilledQuantity: 3,
      shipmentEvidence: 3,
      queuePositions: 4,
      reservations: 1,
      containerAllocations: 1,
      inventoryEvidence: 6,
    });
  });
});