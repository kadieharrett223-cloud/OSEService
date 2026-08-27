import { describe, expect, it } from "vitest";
import { evaluateOrderHealth } from "./order-health";

const line = (overrides = {}) => ({ id: "line-1", product_id: "product-1", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "APPROVED", queue_position_start: 1, queue_position_count: 1, ...overrides });

describe("order health diagnostics", () => {
  it("reports a clean mapped open line", () => {
    expect(evaluateOrderHealth({ lines: [line()] })).toEqual([]);
  });

  it("reports queue count mismatches without changing data", () => {
    const issues = evaluateOrderHealth({ lines: [line({ approved_qty: 2, queue_position_count: 1 })] });
    expect(issues.some((issue) => issue.code === "QUEUE_COUNT_MISMATCH")).toBe(true);
  });

  it("reports an active voided invoice", () => {
    const issues = evaluateOrderHealth({ lines: [line()], qboVoided: true, cancelled: false });
    expect(issues.some((issue) => issue.code === "VOIDED_ACTIVE" && issue.severity === "ERROR")).toBe(true);
  });

  it("reports a dormant QuickBooks order for manual review without treating it as demand", () => {
    const issues = evaluateOrderHealth({ lines: [line({ approved_qty: 0, approval_status: "PENDING_REVIEW" })], qboReviewStatus: "PENDING_REVIEW" });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "QBO_PENDING_REVIEW", severity: "WARNING" }),
    ]));
  });

  it("does not report approved QuickBooks orders as pending review", () => {
    const issues = evaluateOrderHealth({ lines: [line()], qboReviewStatus: "APPROVED" });

    expect(issues.some((issue) => issue.code === "QBO_PENDING_REVIEW")).toBe(false);
  });

  it("accepts dropship fulfillment evidence without shipment history", () => {
    const issues = evaluateOrderHealth({
      lines: [line({ fulfilled_qty: 1, fulfillment_status: "FULFILLED", fulfillment_source: "DROPSHIP", fulfillment_supplier: "Vendor" })],
      fulfillments: [{ shipping_order_line_id: "line-1", fulfilled_qty: 1, fulfillment_type: "DROPSHIP" }],
    });

    expect(issues.some((issue) => issue.code === "FULFILLMENT_TOTAL_MISMATCH")).toBe(false);
  });

  it("accepts other fulfillment evidence without shipment history", () => {
    const issues = evaluateOrderHealth({
      lines: [line({ fulfilled_qty: 1, fulfillment_status: "FULFILLED", fulfillment_source: "OTHER", fulfillment_notes: "Legacy shipment verified" })],
      fulfillments: [{ shipping_order_line_id: "line-1", fulfilled_qty: 1, fulfillment_type: "OTHER" }],
    });

    expect(issues.some((issue) => issue.code === "FULFILLMENT_TOTAL_MISMATCH")).toBe(false);
  });
});
