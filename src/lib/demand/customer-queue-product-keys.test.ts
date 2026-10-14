import { describe, expect, it } from "vitest";
import { customerQueueProductKeys } from "./customer-queue-product-keys";
import { projectCanonicalCustomerQueuesByProductKey, type CanonicalCustomerQueueRow } from "./canonical-customer-queue";

describe("queue product identity matches inventory display", () => {
  it("does not mix 4PML customers into Little Buddy, or number merged 4PML identities separately", () => {
    const products = [
      { id: "old-pml", sku: "000011", canonical_name: "HL-4PML-9", source_record_id: "recycled" },
      { id: "new-pml", sku: "4PML-9", canonical_name: "4PML-9" },
      { id: "little-buddy", sku: "4PC-6", canonical_name: "Little Buddy" },
    ];
    const lines = [
      { id: "older", product_id: "old-pml", legacy_item_code: "4PML-9-1 (deleted)", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED" },
      { id: "newer", product_id: "new-pml", legacy_item_code: "4PML-9", ordered_qty: 2, approved_qty: 2, fulfilled_qty: 0, approval_status: "APPROVED" },
      { id: "michael", product_id: "little-buddy", legacy_item_code: "4PC-6", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED" },
    ];
    const before = JSON.stringify({ products, lines });
    const keys = customerQueueProductKeys(products, [], { recycled: "4PC-6" }, lines);
    expect(keys.get("old-pml")).toBe("4PML9");
    expect(keys.get("new-pml")).toBe("4PML9");
    expect(keys.get("little-buddy")).toBe("4PC6");
    const rows = lines.map((line, index): CanonicalCustomerQueueRow => ({
      lineId: line.id, logicalDemandKey: line.id, invoice: String(index), orderId: line.id, sourceInvoiceId: line.id,
      openQty: line.ordered_qty, approvedQty: line.ordered_qty, qty: line.ordered_qty, shippedQty: 0,
      warehouseQty: 0, waitingQty: line.ordered_qty, inWarehouse: false, willCall: false,
      invoiceOrderedQty: null, provenInvoiceShippedQty: 0, invoiceFullyShipped: false,
      firstPaymentAt: `2026-01-0${index + 1}`, invoiceDate: null, priorityDate: null,
      priorityDateSource: "FIRST_PAYMENT", orderCreatedAt: null, storedPosition: 73,
    }));
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const projected = projectCanonicalCustomerQueuesByProductKey(rows, (row) => keys.get(lineById.get(row.lineId)!.product_id)!);
    expect(projected.map((row) => [row.lineId, row.position])).toEqual([["older", "1"], ["newer", "2-3"], ["michael", "1"]]);
    expect(JSON.stringify({ products, lines })).toBe(before);
  });
});
