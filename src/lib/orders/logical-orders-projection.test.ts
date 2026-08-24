import { describe, expect, it } from "vitest";
import { buildLogicalOrdersProjection } from "./logical-orders-projection";

describe("logical Orders projection", () => {
  it("combines active same-invoice parent evidence into one canonical list row", () => {
    const projection = buildLogicalOrdersProjection([
      {
        id: "qbo-parent",
        source_type: "QBO_INVOICE",
        source_invoice_id: "invoice-122353",
        created_at: "2026-08-13T00:00:00.000Z",
        shipping_order_lines: [{ id: "4pxl", fulfilled_qty: 1 }, { id: "hpu", fulfilled_qty: 1 }],
      },
      {
        id: "old-erp-parent",
        source_type: "OLD_ERP",
        source_invoice_id: "invoice-122353",
        created_at: "2026-08-12T00:00:00.000Z",
        shipping_order_lines: [{ id: "urjt", fulfilled_qty: 1 }],
      },
    ]);

    expect(projection).toHaveLength(1);
    expect(projection[0]?.id).toBe("qbo-parent");
    expect(projection[0]?.shipping_order_lines.map((line) => line.id)).toEqual(["4pxl", "hpu", "urjt"]);
  });

  it("excludes retired parent evidence from the logical list row", () => {
    const projection = buildLogicalOrdersProjection([
      { id: "qbo-parent", source_type: "QBO_INVOICE", source_invoice_id: "invoice-122353", shipping_order_lines: [{ id: "current" }] },
      { id: "retired-parent", source_invoice_id: "invoice-122353", duplicate_of_order_id: "qbo-parent", shipping_order_lines: [{ id: "retired" }] },
    ]);

    expect(projection).toHaveLength(1);
    expect(projection[0]?.shipping_order_lines.map((line) => line.id)).toEqual(["current"]);
  });
});
