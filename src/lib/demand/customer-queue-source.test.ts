import { describe, expect, it } from "vitest";
import { otherFulfillmentQueueIdentities } from "./customer-queue-source";
import { demandLineIdentity, getCanonicalOpenDemandLines, openQtyOf } from "./product-demand";

describe("saved Other source controls only the active Customer List", () => {
  const line = { id: "current", product_id: "lift", qbo_invoice_line_id: "qbo-line", approved_qty: 4, ordered_qty: 4, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", parent_source_type: "QBO_INVOICE" };
  it("excludes all aliases of the Other obligation, not another customer's same product", () => {
    const canonical = [{ ...line, fulfillment_source: "OTHER" }, { ...line, id: "another", qbo_invoice_line_id: "another-qbo-line", fulfillment_source: "WAREHOUSE" }];
    const excluded = otherFulfillmentQueueIdentities(canonical);
    const displayedLines = [...canonical, { ...line, id: "legacy-copy" }].filter((row) => !excluded.has(demandLineIdentity(row)));
    expect(displayedLines.map((row) => row.id)).toEqual(["another"]);
  });
  it("restores a later Warehouse assignment even when a stale Other sibling exists", () => {
    const rows = [{ ...line, fulfillment_source: "WAREHOUSE" }, { ...line, id: "legacy-copy", parent_source_type: "OLD_ERP", fulfillment_source: "OTHER" }];
    const canonical = getCanonicalOpenDemandLines(rows, new Set(), new Set());
    expect(canonical).toHaveLength(1);
    expect(otherFulfillmentQueueIdentities(canonical).size).toBe(0);
  });
  it("leaves ordered, sold/open demand and shipped quantities unchanged for every source", () => {
    for (const source of ["OTHER", "CUSTOMER_NOT_READY", "WAREHOUSE", "DROPSHIP", null]) {
      const row = { ...line, fulfillment_source: source };
      const canonical = getCanonicalOpenDemandLines([row], new Set(), new Set());
      expect(canonical).toEqual([row]);
      expect(openQtyOf(canonical[0])).toBe(4);
      expect(otherFulfillmentQueueIdentities(canonical).size).toBe(source === "OTHER" || source === "CUSTOMER_NOT_READY" ? 1 : 0);
    }
  });
  it("normalizes Other and ignores the superseded readiness setting", () => {
    expect(otherFulfillmentQueueIdentities([{ ...line, fulfillment_source: " other ", customer_queue_paused: false }]).size).toBe(1);
    expect(otherFulfillmentQueueIdentities([{ ...line, fulfillment_source: "WAREHOUSE", customer_queue_paused: true }]).size).toBe(0);
  });
});
