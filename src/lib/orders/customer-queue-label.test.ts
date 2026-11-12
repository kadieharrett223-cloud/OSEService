import { describe, expect, it } from "vitest";
import { customerQueueLabel } from "./customer-queue-label";

describe("customer queue status describes actual mapping and membership", () => {
  it("never labels a mapped inventory product as needing mapping approval", () => {
    const mapped = { product_id: "real-inventory-product", approval_status: "PENDING_REVIEW" };
    expect(customerQueueLabel(mapped, null)).toBe("Customer list: Not in the active list — check order eligibility");
    expect(customerQueueLabel(mapped, "4-5")).toBe("Customer list position: #4-5");
  });
  it("keeps an absent obligation visible instead of inventing a queue position", () => {
    expect(customerQueueLabel({ product_id: "mapped" })).toContain("Not in the active list");
    expect(customerQueueLabel({ product_id: null })).toContain("Inventory item not linked");
  });
  it("preserves deliberate source exclusions even when a stale position is present", () => {
    expect(customerQueueLabel({ product_id: "mapped", fulfillment_source: "OTHER" }, "1")).toContain("Excluded — Other fulfillment");
    expect(customerQueueLabel({ product_id: "mapped", fulfillment_source: "CUSTOMER_NOT_READY" }, "1")).toContain("Excluded — Customer Not Ready");
  });
});
