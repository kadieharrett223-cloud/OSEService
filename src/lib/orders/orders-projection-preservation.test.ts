import { describe, expect, it } from "vitest";
import { buildLogicalOrdersProjection } from "./logical-orders-projection";
import { classifyOrder } from "./order-visibility";

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

  it("keeps a fulfilled legacy invoice out of Waiting when a pending QBO representation exists", () => {
    const projection = buildLogicalOrdersProjection([
      {
        id: "qbo-parent",
        source_type: "QBO_INVOICE",
        source_invoice_id: "source-125995",
        review_status: "PENDING_REVIEW",
        qbo_invoices: {
          raw_payload: {
            Line: [{
              DetailType: "SalesItemLineDetail",
              SalesItemLineDetail: { Qty: 1, ItemRef: { name: "4PHR-9X" } },
            }],
          },
        },
        shipping_order_lines: [{
          id: "qbo-line",
          product_id: "lift",
          approval_status: "PENDING_REVIEW",
          warehouse_status: "PENDING_REVIEW",
          fulfillment_status: "PENDING",
          ordered_qty: 1,
          approved_qty: 0,
          fulfilled_qty: 0,
          products: { sku: "4PHR-9X" },
        }],
      },
      {
        id: "old-erp-parent",
        source_type: "INTERNAL",
        source_system: "OLD_ERP",
        source_invoice_id: "source-125995",
        review_status: "APPROVED",
        shipping_order_lines: [{
          id: "fulfilled-line",
          product_id: "lift",
          approval_status: "APPROVED",
          warehouse_status: "FULFILLED",
          fulfillment_status: "FULFILLED",
          ordered_qty: 1,
          approved_qty: 1,
          fulfilled_qty: 1,
          products: { sku: "4PHR-9X" },
        }],
      },
    ]);

    const result = classifyOrder(projection[0]!);

    expect(projection).toHaveLength(1);
    expect(result.isNewOrder).toBe(false);
    expect(result.isVisibleOperationalOrder).toBe(false);
    expect(result.isArchivedOrder).toBe(true);
  });
});