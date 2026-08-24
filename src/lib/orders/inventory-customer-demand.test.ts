import { describe, expect, it } from "vitest";
import { getCanonicalPhysicalOrderSummary } from "./physical-fulfillment";

describe("Inventory customer demand", () => {
  it("does not retain a stale OLD ERP warehouse row when the sibling QBO line is fulfilled", () => {
    const staleOldErpLine = {
      id: "old-4pxl",
      product_id: "product-4pxl",
      ordered_qty: 1,
      approved_qty: 1,
      fulfilled_qty: 0,
      approval_status: "APPROVED",
      fulfillment_status: "PENDING",
      warehouse_status: "IN_WAREHOUSE",
      legacy_item_code: "4PXL-10",
      products: { sku: "000173", canonical_name: "Olympic 4PXL-10" },
    };
    const completedQboLine = {
      id: "qbo-4pxl",
      product_id: "product-4pxl",
      ordered_qty: 1,
      approved_qty: 0,
      fulfilled_qty: 1,
      approval_status: "PENDING_REVIEW",
      fulfillment_status: "FULFILLED",
      warehouse_status: "FULFILLED",
      products: { sku: "000173", canonical_name: "Olympic 4PXL-10" },
    };
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: { Line: [{ Id: "1", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "4PXL-10" } } }] },
      lines: [staleOldErpLine, completedQboLine],
    });
    const item = summary.items[0];

    expect(item.line?.id).toBe("qbo-4pxl");
    expect(item.remaining).toBe(0);
    expect(item.remaining > 0).toBe(false);
  });

  it("recognizes an invoice as complete when fulfillment evidence is split across QBO and INTERNAL siblings", () => {
    const qboLiftLine = {
      id: "qbo-lift",
      product_id: "lift",
      ordered_qty: 1,
      fulfilled_qty: 1,
      fulfillment_status: "FULFILLED",
      products: { sku: "LIFT" },
    };
    const internalAccessoryLine = {
      id: "internal-accessory",
      product_id: "accessory",
      ordered_qty: 1,
      approved_qty: 1,
      fulfilled_qty: 1,
      fulfillment_status: "FULFILLED",
      legacy_item_code: "ACCESSORY",
      products: { sku: "ACCESSORY" },
    };
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: {
        Line: [
          { Id: "1", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "LIFT" } } },
          { Id: "2", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "ACCESSORY" } } },
        ],
      },
      lines: [qboLiftLine, internalAccessoryLine],
    });

    expect(summary).toMatchObject({ ordered: 2, fulfilled: 2, remaining: 0, isComplete: true });
  });
});