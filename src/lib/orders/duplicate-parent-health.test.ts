import { describe, expect, it } from "vitest";
import { findActiveDuplicateParentConflicts } from "./duplicate-parent-health";

const completedQbo = {
  id: "qbo",
  order_number: "100",
  source_type: "QBO_INVOICE",
  source_invoice_id: "source-100",
  customerName: "Ada Customer",
  lines: [{ product_id: "lift", ordered_qty: 1, fulfilled_qty: 1, products: { sku: "LIFT" } }],
};

describe("findActiveDuplicateParentConflicts", () => {
  it("excludes a completed QBO parent with a non-operational OLD_ERP sibling", () => {
    expect(findActiveDuplicateParentConflicts([
      completedQbo,
      { id: "old", order_number: "100", source_system: "OLD_ERP", source_invoice_id: "source-100", customerName: "Ada Customer", lines: [{ product_id: "lift", ordered_qty: 1, fulfilled_qty: 0, products: { sku: "LIFT" } }] },
    ])).toEqual([]);
  });

  it("reports divergent active sibling evidence without proposing a fix", () => {
    const conflicts = findActiveDuplicateParentConflicts([
      { ...completedQbo, lines: [{ product_id: "lift", ordered_qty: 1, fulfilled_qty: 0, products: { sku: "LIFT" } }] },
      { id: "old", order_number: "100", source_system: "OLD_ERP", source_invoice_id: "source-100", customerName: "Ada Customer", lines: [{ product_id: "motor", ordered_qty: 1, fulfilled_qty: 0, products: { sku: "MOTOR" } }] },
    ]);
    expect(conflicts).toMatchObject([{ invoice: "100", canonicalOrderId: "qbo", staleOrderId: "old", canonical: { products: ["LIFT"] }, stale: { products: ["MOTOR"] } }]);
  });

  it("does not treat different-customer invoice collisions as a duplicate-parent conflict", () => {
    expect(findActiveDuplicateParentConflicts([
      completedQbo,
      { id: "old", order_number: "100", source_system: "OLD_ERP", source_invoice_id: "source-100", customerName: "Other Customer", lines: [{ product_id: "lift", ordered_qty: 1, fulfilled_qty: 0 }] },
    ])).toEqual([]);
  });
});