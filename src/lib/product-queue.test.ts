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
      { ...base, id: "two-units", approved_qty: 2, queue_position_start: 5, queue_position_override: 4, queue_position_override_at: "2026-09-10T00:00:00Z" },
      { ...base, id: "one-unit", approved_qty: 1, queue_position_start: 4, queue_position_override: 6, queue_position_override_at: "2026-09-10T00:00:00Z" },
      { ...base, id: "first", approved_qty: 3, queue_position_start: 1, queue_position_override: null },
    ]);

    expect(positions.map(({ line, start, units }) => [line.id, start, units])).toEqual([
      ["first", 1, 3],
      ["two-units", 4, 2],
      ["one-unit", 6, 1],
    ]);
  });

  it("ignores unaudited legacy positions and sorts them by first payment", () => {
    const base = {
      product_id: "product-1",
      approved_qty: 1,
      fulfilled_qty: 0,
      approval_status: "APPROVED",
      fulfillment_status: "PENDING",
      warehouse_status: "APPROVED",
      priority: "NORMAL",
      queue_position_start: null,
    };
    const positions = calculateQueuePositions([
      { ...base, id: "legacy-first", queue_position_override: 1, shipping_orders: { created_at: "2026-01-01T00:00:00Z", first_payment_at: "2026-07-01T00:00:00Z", review_status: "APPROVED" } },
      { ...base, id: "paid-first", queue_position_override: null, shipping_orders: { created_at: "2026-01-02T00:00:00Z", first_payment_at: "2026-06-01T00:00:00Z", review_status: "APPROVED" } },
    ]);

    expect(positions.map(({ line, start }) => [line.id, start])).toEqual([
      ["paid-first", 1],
      ["legacy-first", 2],
    ]);
  });

  it("places an invoice-date fallback on the same timeline as detected payments", () => {
    const base = {
      product_id: "product-1",
      approved_qty: 1,
      fulfilled_qty: 0,
      approval_status: "APPROVED",
      fulfillment_status: "PENDING",
      warehouse_status: "APPROVED",
      priority: "NORMAL",
      queue_position_start: null,
      queue_position_override: null,
    };
    const positions = calculateQueuePositions([
      { ...base, id: "paid-later", shipping_orders: { created_at: "2026-09-01", first_payment_at: "2026-04-23", review_status: "APPROVED", qbo_invoices: { invoice_date: "2026-04-20" } } },
      { ...base, id: "fallback-first", shipping_orders: { created_at: "2026-09-02", first_payment_at: null, review_status: "APPROVED", qbo_invoices: { invoice_date: "2026-04-11" } } },
    ]);

    expect(positions.map(({ line, start }) => [line.id, start])).toEqual([
      ["fallback-first", 1],
      ["paid-later", 2],
    ]);
  });
});
