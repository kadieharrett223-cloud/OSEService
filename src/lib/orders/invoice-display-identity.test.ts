import { describe, expect, it } from "vitest";
import { canonicalInvoiceDisplayLineIds, type PhysicalFulfillmentLine } from "./physical-fulfillment";

const payload = { Line: [
  { Id: "1", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "4PHR-9X" } } },
  { Id: "5", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "OD-A30" } } },
] };

describe("invoice display uses canonical fulfillment identities", () => {
  it("keeps a shipped lift off the queue and uses the drain's current positioned record", () => {
    const lines: PhysicalFulfillmentLine[] = [
      { id: "old-lift", product_id: "lift", legacy_item_code: "4PHR-9X", products: { sku: "000012" }, ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, fulfillment_status: "PENDING", qbo_invoice_lines: { qbo_line_id: "1" } },
      { id: "shipped-lift", product_id: "lift", products: { sku: "000012" }, ordered_qty: 1, approved_qty: 0, fulfilled_qty: 1, fulfillment_status: "FULFILLED", qbo_invoice_lines: { qbo_line_id: "1" } },
      { id: "old-drain", product_id: "old-drain", legacy_item_code: "OD-A30", products: { sku: "000080" }, ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0 },
      { id: "current-drain", product_id: "drain", products: { sku: "OD-A30" }, ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, qbo_invoice_lines: { qbo_line_id: "5" } },
    ];
    const before = structuredClone(lines);
    const ids = canonicalInvoiceDisplayLineIds(payload, lines);
    expect(ids.get("1")).toBe("shipped-lift");
    expect(ids.get("5")).toBe("current-drain");
    expect(lines).toEqual(before);
  });

  it("keeps distinct same-SKU invoice rows linked to their own operational records", () => {
    const rawPayload = { Line: ["1", "2"].map((Id) => ({ Id, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "HLCJ-6" } } })) };
    const lines = ["1", "2"].map((id): PhysicalFulfillmentLine => ({ id: `jack-${id}`, product_id: "jack", products: { sku: "HLCJ-6" }, ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, qbo_invoice_lines: { qbo_line_id: id } }));
    const ids = canonicalInvoiceDisplayLineIds(rawPayload, lines);
    expect(ids.get("1")).toBe("jack-1");
    expect(ids.get("2")).toBe("jack-2");
  });
});
