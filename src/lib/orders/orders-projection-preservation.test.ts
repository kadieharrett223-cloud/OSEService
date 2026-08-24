import { describe, expect, it } from "vitest";
import { buildLogicalOrdersProjection } from "./logical-orders-projection";

describe("Orders projection preservation", () => {
  it("keeps all active same-invoice evidence in one canonical logical row", () => {
    const projection = buildLogicalOrdersProjection([
      {
        id: "qbo-parent",
        source_type: "QBO_INVOICE",
        source_invoice_id: "source-12310",
        shipping_order_lines: [{ id: "qbo-line", fulfilledQty: 2 }],
      },
      {
        id: "old-erp-parent",
        source_invoice_id: "source-12310",
        shipping_order_lines: [{ id: "old-erp-line", fulfilledQty: 1 }],
      },
      { id: "retired-parent", source_invoice_id: "source-12310", duplicate_of_order_id: "qbo-parent", shipping_order_lines: [{ id: "retired-line" }] },
    ]);

    expect(projection).toHaveLength(1);
    expect(projection[0]?.id).toBe("qbo-parent");
    expect(projection[0]?.shipping_order_lines).toEqual([
      { id: "qbo-line", fulfilledQty: 2 },
      { id: "old-erp-line", fulfilledQty: 1 },
    ]);
  });
});