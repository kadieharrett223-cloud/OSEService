import { describe, expect, it } from "vitest";
import { getOrderCancellationPostconditionErrors } from "./order-cancellation";

describe("order cancellation contract", () => {
  it("accepts cancelled open lines with released allocations while preserving fulfilled lines", () => {
    expect(getOrderCancellationPostconditionErrors("CANCELLED", [
      {
        id: "open-line",
        ordered_qty: 2,
        approved_qty: 2,
        fulfilled_qty: 0,
        approval_status: "REMOVED",
        fulfillment_status: "CANCELLED",
        inventory_allocations: [{ allocation_status: "RELEASED" }],
      },
      {
        id: "shipped-line",
        ordered_qty: 1,
        approved_qty: 1,
        fulfilled_qty: 1,
        approval_status: "APPROVED",
        fulfillment_status: "FULFILLED",
        inventory_allocations: [],
      },
    ])).toEqual([]);
  });

  it("rejects a success state while open demand or a live allocation remains", () => {
    expect(getOrderCancellationPostconditionErrors("CANCELLED", [{
      id: "bad-line",
      ordered_qty: 1,
      fulfilled_qty: 0,
      approval_status: "APPROVED",
      fulfillment_status: "PENDING",
      inventory_allocations: [{ allocation_status: "ALLOCATED" }],
    }])).toEqual([
      "open_line_not_cancelled:bad-line",
      "live_allocation_not_released:bad-line",
    ]);
  });

  it("rejects a row that was not moved into the Cancelled lifecycle", () => {
    expect(getOrderCancellationPostconditionErrors(null, [])).toEqual(["order_not_cancelled"]);
  });
});
