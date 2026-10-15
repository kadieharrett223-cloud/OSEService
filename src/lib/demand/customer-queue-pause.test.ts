import { describe, expect, it } from "vitest";
import { pausedCustomerQueueIdentities } from "./customer-queue-pause";
import { demandLineIdentity, getCanonicalOpenDemandLines, openQtyOf } from "./product-demand";

describe("customer readiness is not fulfillment or inventory", () => {
  const line = { id: "current", product_id: "lift", qbo_invoice_line_id: "qbo-line", approved_qty: 4, ordered_qty: 4, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", parent_source_type: "QBO_INVOICE" };
  it("pauses all representations of an obligation, not another customer's same product", () => {
    const lines = [
      { ...line, customer_queue_paused: true },
      { ...line, id: "old-copy" },
      { ...line, id: "other-customer", qbo_invoice_line_id: "other-qbo-line" },
    ];
    const paused = pausedCustomerQueueIdentities(lines);
    expect(lines.filter((row) => !paused.has(demandLineIdentity(row))).map((row) => row.id)).toEqual(["other-customer"]);
  });
  it("retains all physical demand, quantities and source while paused and after resuming", () => {
    const active = { ...line, fulfillment_source: "OTHER", customer_queue_paused: false };
    const paused = { ...active, customer_queue_paused: true };
    expect(pausedCustomerQueueIdentities([paused]).size).toBe(1);
    expect(pausedCustomerQueueIdentities([active]).size).toBe(0);
    for (const row of [active, paused]) {
      const canonical = getCanonicalOpenDemandLines([row], new Set(), new Set());
      expect(canonical).toHaveLength(1);
      expect(openQtyOf(canonical[0])).toBe(4);
      expect(canonical[0].fulfillment_status).toBe("PENDING");
      expect(canonical[0].fulfillment_source).toBe("OTHER");
    }
  });
  it("does not silently pause existing Other or Dropship assignments", () => {
    expect(pausedCustomerQueueIdentities([
      { ...line, fulfillment_source: "OTHER" },
      { ...line, fulfillment_source: "DROPSHIP" },
    ]).size).toBe(0);
  });
});
