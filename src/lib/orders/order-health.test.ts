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
});
