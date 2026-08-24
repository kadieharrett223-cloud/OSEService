import { describe, expect, it } from "vitest";
import { dedupeDemandLines, excludeCompletedQboSiblings, isOpenDemandLine, totalOpenDemand } from "./product-demand";

describe("shared active logical demand", () => {
  it("dedupes deterministic cross-source representations by QBO logical key", () => {
    const lines = [
      { id: "old", logical_demand_key: "qbo-line-1", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" },
      { id: "qbo", qbo_invoice_line_id: "qbo-line-1", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" },
    ];
    expect(dedupeDemandLines(lines)).toHaveLength(1);
    expect(totalOpenDemand(lines)).toBe(1);
  });

  it("keeps the reserved representation when duplicate rows have equal demand", () => {
    const lines = [
      { id: "qbo", logical_demand_key: "qbo-line-1", approved_qty: 1, fulfilled_qty: 0, warehouse_status: "APPROVED", fulfillment_status: "PENDING" },
      { id: "old", logical_demand_key: "qbo-line-1", approved_qty: 1, fulfilled_qty: 0, warehouse_status: "IN_WAREHOUSE", fulfillment_status: "PENDING" },
    ];
    expect(dedupeDemandLines(lines)[0].warehouse_status).toBe("IN_WAREHOUSE");
  });

  it("excludes duplicate, cancelled, and voided parents from active demand", () => {
    expect(isOpenDemandLine({ id: "duplicate", approved_qty: 1, parent_duplicate_of_order_id: "parent", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "cancelled", approved_qty: 1, parent_cancellation_status: "CANCELLED", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "voided", approved_qty: 1, parent_qbo_voided: true, fulfillment_status: "PENDING" })).toBe(false);
  });

  it("removes only the bridged sibling of a completed QBO order", () => {
    const rows = [
      { id: "old", logical_demand_key: "qbo-line", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" },
      { id: "qbo", qbo_invoice_line_id: "qbo-line", approved_qty: 0, fulfilled_qty: 1, fulfillment_status: "FULFILLED" },
      { id: "open", logical_demand_key: "open-qbo-line", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" },
    ];

    expect(excludeCompletedQboSiblings(rows, new Set(["qbo-line"])).map((line) => line.id)).toEqual(["qbo", "open"]);
    expect(excludeCompletedQboSiblings(rows, new Set()).map((line) => line.id)).toEqual(["old", "qbo", "open"]);
  });
});
