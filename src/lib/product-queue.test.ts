import { describe, expect, it } from "vitest";
import { isActiveQueueLine } from "./product-queue";

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
});