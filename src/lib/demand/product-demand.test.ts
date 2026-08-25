import { describe, expect, it } from "vitest";
import { getWarehouseDemandDisplay } from "./display-status";
import { dedupeDemandLines, excludeCompletedQboOrderSiblings, excludeCompletedQboSiblings, getCanonicalOpenDemandLines, isOpenDemandLine, openQtyOf, totalOpenDemand, withLogicalFulfilledQty, withProvenFulfilledQty } from "./product-demand";

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

  it("shares fulfillment evidence across linked siblings while preserving a partial remainder", () => {
    const rows = [
      { id: "old", logical_demand_key: "qbo-line-1", approved_qty: 3, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "IN_WAREHOUSE" },
      { id: "qbo", qbo_invoice_line_id: "qbo-line-1", approved_qty: 3, fulfilled_qty: 1, fulfillment_status: "FULFILLED" },
    ];

    const projected = withLogicalFulfilledQty(rows);
    expect(openQtyOf(projected[0])).toBe(2);
    expect(isOpenDemandLine(projected[0])).toBe(true);
    expect(openQtyOf(withLogicalFulfilledQty([{ ...rows[0], approved_qty: 1 }, { ...rows[1], approved_qty: 1, fulfilled_qty: 1 }])[0])).toBe(0);
  });

  it("removes Joshua 122353 from every active-demand surface when its QBO sibling shipped", () => {
    const projected = withLogicalFulfilledQty([
      { id: "59b6d8d1-2134-406f-8444-63e99f5856c7", logical_demand_key: "e03613c6-f085-471a-945c-de86f59ff99e", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "IN_WAREHOUSE" },
      { id: "8b184974-aa80-4a94-aec3-1dd73ca868d0", qbo_invoice_line_id: "e03613c6-f085-471a-945c-de86f59ff99e", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED", warehouse_status: "FULFILLED" },
    ]);

    expect(openQtyOf(projected[0])).toBe(0);
    expect(isOpenDemandLine(projected[0])).toBe(false);
    expect(getWarehouseDemandDisplay({ openQty: openQtyOf(projected[0]), warehouseStatus: projected[0].warehouse_status })).toMatchObject({ warehouseQty: 0, inWarehouse: false });
  });

  it("keeps normal and partially shipped demand active but excludes fully shipped Warehouse and Dropship lines", () => {
    const normal = { id: "normal", approved_qty: 1, fulfilled_qty: 0, fulfillment_status: "PENDING", warehouse_status: "APPROVED" };
    const partial = { id: "partial", approved_qty: 3, fulfilled_qty: 1, fulfillment_status: "PENDING", warehouse_status: "IN_WAREHOUSE" };
    const warehouseShipped = { id: "warehouse", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED", warehouse_status: "IN_WAREHOUSE", fulfillment_source: "WAREHOUSE" };
    const dropshipShipped = { id: "dropship", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED", warehouse_status: "IN_WAREHOUSE", fulfillment_source: "DROPSHIP" };

    expect(openQtyOf(normal)).toBe(1);
    expect(isOpenDemandLine(normal)).toBe(true);
    expect(openQtyOf(partial)).toBe(2);
    expect(isOpenDemandLine(partial)).toBe(true);
    expect(isOpenDemandLine(warehouseShipped)).toBe(false);
    expect(isOpenDemandLine(dropshipShipped)).toBe(false);
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

  it("keeps a paid QBO-only obligation while excluding its fulfilled and voided siblings", () => {
    const rows = [
      { id: "paid-qbo-only", qbo_invoice_line_id: "qbo-live", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" },
      { id: "fulfilled-old-erp", logical_demand_key: "qbo-fulfilled", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" },
      { id: "fulfilled-qbo", qbo_invoice_line_id: "qbo-fulfilled", approved_qty: 1, fulfilled_qty: 1, approval_status: "APPROVED", fulfillment_status: "FULFILLED" },
      { id: "voided-qbo", qbo_invoice_line_id: "qbo-voided", approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", parent_qbo_voided: true },
    ];

    expect(getCanonicalOpenDemandLines(rows, new Set(["qbo-fulfilled"]), new Set()).map((line) => line.id)).toEqual(["paid-qbo-only"]);
  });

  it("keeps reviewed SKU corrections, replacements, and duplicate imports terminal across source siblings", () => {
    const rows = [
      { id: "11601-old", source_record_id: "da25408f-149b-4387-92e9-1591e56c5afb", logical_demand_key: "6f592815-0062-46cd-b308-431ca6392ebc", approved_qty: 1, fulfillment_status: "PENDING" },
      { id: "11601-qbo", qbo_invoice_line_id: "6f592815-0062-46cd-b308-431ca6392ebc", approved_qty: 1, fulfillment_status: "PENDING" },
      { id: "12580-old", source_record_id: "563ea9db-9749-4131-b8c1-e3f1f8de2014", logical_demand_key: "643540d5-6cb4-47e0-885d-f83335eafe2a", approved_qty: 1, fulfillment_status: "PENDING" },
      { id: "12580-qbo", qbo_invoice_line_id: "643540d5-6cb4-47e0-885d-f83335eafe2a", approved_qty: 1, fulfillment_status: "PENDING" },
      { id: "122332-old", source_record_id: "1752481a-2b8f-4ad2-ae93-efb6c84f24d1", approved_qty: 1, fulfillment_status: "PENDING" },
      { id: "unrelated-open", source_record_id: "unrelated", approved_qty: 1, fulfillment_status: "PENDING" },
    ];
    const resolutions = [
      { source_record_id: "da25408f-149b-4387-92e9-1591e56c5afb", qbo_invoice_line_id: "6f592815-0062-46cd-b308-431ca6392ebc", resolution_type: "SKU_CORRECTION" as const },
      { source_record_id: "563ea9db-9749-4131-b8c1-e3f1f8de2014", qbo_invoice_line_id: "643540d5-6cb4-47e0-885d-f83335eafe2a", resolution_type: "DUPLICATE" as const },
      { source_record_id: "1752481a-2b8f-4ad2-ae93-efb6c84f24d1", resolution_type: "REPLACED" as const },
    ];

    expect(getCanonicalOpenDemandLines(rows, new Set(), new Set(), resolutions).map((line) => line.id)).toEqual(["unrelated-open"]);
  });

  it("does not suppress an obligation when its reviewed resolution is revoked", () => {
    const rows = [
      { id: "reimported-source", source_record_id: "reviewed-source", approved_qty: 1, fulfillment_status: "PENDING" },
    ];

    const resolutions = [
      { source_record_id: "reviewed-source", resolution_type: "DUPLICATE" as const, status: "REVOKED" as const },
    ];

    expect(getCanonicalOpenDemandLines(rows, new Set(), new Set(), resolutions).map((line) => line.id)).toEqual(["reimported-source"]);
  });
});
