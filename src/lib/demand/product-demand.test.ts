import { describe, expect, it } from "vitest";
import { dedupeDemandLines, excludeCompletedQboOrderSiblings, excludeCompletedQboSiblings, isOpenDemandLine, openQtyOf, totalOpenDemand, withProvenFulfilledQty } from "./product-demand";

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

  it("excludes duplicate, cancelled, archived, fulfilled, shipped, and voided parents from active demand", () => {
    expect(isOpenDemandLine({ id: "duplicate", approved_qty: 1, parent_duplicate_of_order_id: "parent", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "cancelled", approved_qty: 1, parent_cancellation_status: "CANCELLED", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "archived", approved_qty: 1, parent_review_status: "ARCHIVED", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "fulfilled-parent", approved_qty: 1, parent_review_status: "FULFILLED", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "shipped-parent", approved_qty: 1, parent_review_status: "SHIPPED", fulfillment_status: "PENDING" })).toBe(false);
    expect(isOpenDemandLine({ id: "voided", approved_qty: 1, parent_qbo_voided: true, fulfillment_status: "PENDING" })).toBe(false);
  });

  it("excludes shipped lines from active demand even if a legacy row has not updated its quantity", () => {
    expect(isOpenDemandLine({ id: "shipped", approved_qty: 1, fulfilled_qty: 0, fulfillment_status: "SHIPPED" })).toBe(false);
  });

  it("uses recorded fulfillment quantity to remove only shipped demand from a stale queue line", () => {
    const staleLine = { id: "line", approved_qty: 3, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" };

    expect(openQtyOf(withProvenFulfilledQty(staleLine, 3))).toBe(0);
    expect(isOpenDemandLine(withProvenFulfilledQty(staleLine, 3))).toBe(false);
    expect(openQtyOf(withProvenFulfilledQty(staleLine, 1))).toBe(2);
    expect(isOpenDemandLine(withProvenFulfilledQty(staleLine, 1))).toBe(true);
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

  it("removes every row for a completed QBO invoice, including stale QBO warehouse rows", () => {
    const rows = [
      { id: "old-lift", parent_source_type: "INTERNAL", parent_source_invoice_id: "invoice-1", approved_qty: 1 },
      { id: "old-accessory", parent_source_type: "INTERNAL", parent_source_invoice_id: "invoice-1", approved_qty: 1 },
      { id: "legacy", parent_source_invoice_id: "invoice-1", approved_qty: 1 },
      { id: "qbo", parent_source_type: "QBO_INVOICE", parent_source_invoice_id: "invoice-1", approved_qty: 0, fulfilled_qty: 1 },
      { id: "open", parent_source_type: "INTERNAL", parent_source_invoice_id: "invoice-2", approved_qty: 1 },
    ];

    expect(excludeCompletedQboOrderSiblings(rows, new Set(["invoice-1"])).map((line) => line.id)).toEqual(["open"]);
  });
});
