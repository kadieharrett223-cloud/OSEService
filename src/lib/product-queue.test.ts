import { describe, expect, it } from "vitest";
import { calculateQueuePositions, isActiveQueueLine } from "./product-queue";

describe("stored product queue eligibility", () => {
  it("excludes a mapped pending-review parent even when its line has approved quantity", () => {
    expect(isActiveQueueLine({
      id: "pending-review-line",
      product_id: "product-1",
      approved_qty: 1,
      fulfilled_qty: 0,
      approval_status: "APPROVED",
      fulfillment_status: "PENDING",
      warehouse_status: "PENDING_REVIEW",
      priority: "NORMAL",
      queue_position_override: null,
      queue_position_start: 3,
      shipping_orders: { created_at: "2026-01-01T00:00:00Z", review_status: "PENDING_REVIEW" },
    })).toBe(false);
  });

  it("preserves non-overlapping manual positions when moving a multi-unit customer", () => {
    const base = {
      product_id: "product-1",
      fulfilled_qty: 0,
      approval_status: "APPROVED",
      fulfillment_status: "PENDING",
      warehouse_status: "APPROVED",
      priority: "NORMAL",
      shipping_orders: { created_at: "2026-01-01T00:00:00Z", review_status: "APPROVED" },
    };
    const positions = calculateQueuePositions([
      { ...base, id: "two-units", approved_qty: 2, queue_position_start: 5, queue_position_override: 4 },
      { ...base, id: "one-unit", approved_qty: 1, queue_position_start: 4, queue_position_override: 6 },
      { ...base, id: "first", approved_qty: 3, queue_position_start: 1, queue_position_override: null },
    ]);

    expect(positions.map(({ line, start, units }) => [line.id, start, units])).toEqual([
      ["first", 1, 3],
      ["two-units", 4, 2],
      ["one-unit", 6, 1],
    ]);
  });
});