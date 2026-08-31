import { describe, expect, it } from "vitest";
import { classifyOrder, matchesOrderTab, sortNewOrdersByOperationalRecency, type ClassificationLine, type ClassificationOrder } from "./order-visibility";

function line(overrides: Partial<ClassificationLine> = {}): ClassificationLine {
  return {
    product_id: "product-1",
    approval_status: "APPROVED",
    warehouse_status: "APPROVED",
    fulfillment_status: "PENDING",
    ordered_qty: 1,
    approved_qty: 1,
    fulfilled_qty: 0,
    products: { sku: "SKU-1" },
    ...overrides,
  };
}

function order(overrides: Partial<ClassificationOrder> = {}): ClassificationOrder {
  return {
    order_number: "126111",
    source_type: "QBO_INVOICE",
    review_status: "APPROVED",
    shipping_order_lines: [line()],
    ...overrides,
  };
}

describe("orders visibility and activation", () => {
  it("places the most recently entered invoice first in New Orders", () => {
    const orders = sortNewOrdersByOperationalRecency([
      { invoice: "older", updatedAt: "2026-08-01T09:00:00.000Z" },
      { invoice: "just-entered", updatedAt: "2026-08-31T10:00:00.000Z" },
      { invoice: "middle", updatedAt: "2026-08-20T09:00:00.000Z" },
    ]);

    expect(orders.map((order) => order.invoice)).toEqual(["just-entered", "middle", "older"]);
  });

  it("hides a dormant PENDING_REVIEW bulk import that was never activated", () => {
    // Exactly the shape of historical imports 7955 / 8040: ordered qty but nothing approved.
    const result = classifyOrder(order({
      order_number: "7955",
      review_status: "PENDING_REVIEW",
      shipping_order_lines: [line({ approval_status: "PENDING_REVIEW", approved_qty: 0, ordered_qty: 1 })],
    }));

    expect(result.isVisibleOperationalOrder).toBe(false);
    expect(result.isNewOrder).toBe(false);
  });

  it("shows an explicitly entered QBO order as visible and New", () => {
    // Entering an invoice activates it (review_status leaves PENDING_REVIEW) and approves its lines.
    const result = classifyOrder(order({
      order_number: "126111",
      review_status: "APPROVED",
      shipping_order_lines: [line({ approval_status: "APPROVED", approved_qty: 1 })],
    }));

    expect(result.isVisibleOperationalOrder).toBe(true);
    expect(result.isNewOrder).toBe(true);
  });

  it("keeps a mapped open 126037 order operational", () => {
    const result = classifyOrder(order({
      order_number: "126037",
      shipping_order_lines: [line({ products: { sku: "4032S" } })],
    }));

    expect(result.isVisibleOperationalOrder).toBe(true);
    expect(result.operationalLines).toHaveLength(1);
  });

  it("keeps a reconciled OLD_ERP order visible when it has approved remaining demand", () => {
    const result = classifyOrder(order({
      order_number: "11746",
      source_type: "MANUAL",
      review_status: "PENDING_REVIEW",
      shipping_order_lines: [line({ approval_status: "APPROVED", approved_qty: 2, fulfilled_qty: 1 })],
    }));

    expect(result.isVisibleOperationalOrder).toBe(true);
  });

  it("keeps an activated but still unmapped QBO order visible so it can be mapped", () => {
    const result = classifyOrder(order({
      review_status: "APPROVED",
      shipping_order_lines: [line({ product_id: null, approval_status: "PENDING_REVIEW", approved_qty: 0 })],
    }));

    expect(result.isVisibleOperationalOrder).toBe(true);
    expect(result.isNewOrder).toBe(true);
  });

  it("keeps an activated QBO order with no lines yet visible", () => {
    const result = classifyOrder(order({ review_status: "APPROVED", shipping_order_lines: [] }));
    expect(result.isVisibleOperationalOrder).toBe(true);
  });

  it("does not treat a dormant order with no lines as visible", () => {
    const result = classifyOrder(order({ review_status: "PENDING_REVIEW", shipping_order_lines: [] }));
    expect(result.isVisibleOperationalOrder).toBe(false);
  });

  it("moves warehouse and shipped work out of New", () => {
    const warehouse = classifyOrder(order({
      shipping_order_lines: [line({ warehouse_status: "IN_WAREHOUSE" })],
    }));
    expect(warehouse.isNewOrder).toBe(false);
    expect(warehouse.isWarehouseOrder).toBe(true);

    const partial = classifyOrder(order({
      shipping_order_lines: [line({ approved_qty: 2, fulfilled_qty: 1 })],
    }));
    expect(partial.isNewOrder).toBe(false);
    expect(partial.isPartiallyShippedOrder).toBe(true);
  });

  it("excludes lines whose SKU is awaiting manual mapping from operational demand", () => {    const result = classifyOrder(
      order({ review_status: "PENDING_REVIEW", shipping_order_lines: [line({ products: { sku: "JVCJ-6" } })] }),
      { manualMappingSkus: new Set(["JVCJ-6"]) },
    );

    expect(result.operationalLines).toHaveLength(0);
    expect(result.isVisibleOperationalOrder).toBe(false);
  });

  it("classifies a part-shipped order as Partially Shipped and never New", () => {
    // One unit shipped, one still owed: it must leave New and appear as partially shipped.
    const result = classifyOrder(order({
      shipping_order_lines: [
        line({ approved_qty: 2, fulfilled_qty: 1, fulfillment_status: "PARTIALLY_FULFILLED" }),
        line({ approved_qty: 1, fulfilled_qty: 0 }),
      ],
    }));

    expect(result.isPartiallyShippedOrder).toBe(true);
    expect(result.isNewOrder).toBe(false);
    expect(result.isVisibleOperationalOrder).toBe(true);
  });

  it("classifies shipped QBO orders with remaining mapped review lines as Partially Shipped", () => {
    const result = classifyOrder(order({
      shipping_order_lines: [
        line({ approved_qty: 0, ordered_qty: 1, fulfilled_qty: 1, approval_status: "PENDING_REVIEW", fulfillment_status: "FULFILLED" }),
        line({ approved_qty: 0, ordered_qty: 1, fulfilled_qty: 0, approval_status: "PENDING_REVIEW", fulfillment_status: "PENDING" }),
      ],
    }));

    expect(result.isPartiallyShippedOrder).toBe(true);
    expect(result.isNewOrder).toBe(false);
  });

  it("keeps shipped orders in Partially Shipped even when review status is still pending", () => {
    const result = classifyOrder(order({
      review_status: "PENDING_REVIEW",
      shipping_order_lines: [
        line({ approved_qty: 0, ordered_qty: 2, fulfilled_qty: 1, approval_status: "PENDING_REVIEW", fulfillment_status: "PARTIALLY_FULFILLED" }),
      ],
    }));

    expect(result.isPartiallyShippedOrder).toBe(true);
    expect(result.isVisibleOperationalOrder).toBe(false);
  });

  it("keeps a refreshed order in New only while remaining demand exists", () => {
    const withDemand = classifyOrder(order({ shipping_order_lines: [line({ approved_qty: 2, fulfilled_qty: 0 })] }));
    expect(withDemand.isNewOrder).toBe(true);

    const fullyShipped = classifyOrder(order({
      shipping_order_lines: [line({ approved_qty: 2, fulfilled_qty: 2, fulfillment_status: "FULFILLED" })],
    }));
    expect(fullyShipped.isNewOrder).toBe(false);
    expect(fullyShipped.isArchivedOrder).toBe(true);
  });

  it("keeps a completed three-unit order out of normal Orders", () => {
    const result = classifyOrder(order({
      order_number: "126079",
      review_status: "FULFILLED",
      shipping_order_lines: [
        line({ approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
      ],
    }));

    expect(result.isVisibleOperationalOrder).toBe(false);
    expect(result.isArchivedOrder).toBe(true);
    expect(matchesOrderTab(result, "orders")).toBe(false);
    expect(matchesOrderTab(result, "archived")).toBe(true);
  });

  it("keeps an explicitly archived order out of Warehouse even when legacy line statuses are stale", () => {
    const result = classifyOrder(order({
      review_status: "ARCHIVED",
      shipping_order_lines: [line({ warehouse_status: "IN_WAREHOUSE", approved_qty: 1, fulfilled_qty: 0 })],
    }));

    expect(result.isVisibleOperationalOrder).toBe(false);
    expect(result.isWarehouseOrder).toBe(false);
    expect(result.isPartiallyShippedOrder).toBe(false);
    expect(result.isArchivedOrder).toBe(true);
  });

  it("archives fully fulfilled physical orders even when a note line remains open", () => {
    const result = classifyOrder(order({
      shipping_order_lines: [
        line({ product_id: "lift", approved_qty: 2, fulfilled_qty: 2, fulfillment_status: "FULFILLED" }),
        line({ product_id: "motor", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ product_id: "note-product", legacy_item_code: "Note", approved_qty: 1, fulfilled_qty: 0, fulfillment_status: "PENDING", products: { sku: "Note" } }),
      ],
    }));

    expect(result.isArchivedOrder).toBe(true);
    expect(result.isVisibleOperationalOrder).toBe(false);
    expect(result.isNewOrder).toBe(false);
    expect(result.isWarehouseOrder).toBe(false);
    expect(result.isPartiallyShippedOrder).toBe(false);
  });

  it("maps classifications onto the correct tabs", () => {    const active = classifyOrder(order());
    expect(matchesOrderTab(active, "orders")).toBe(true);
    expect(matchesOrderTab(active, "new")).toBe(true);
    expect(matchesOrderTab(active, "archived")).toBe(false);

    const dormant = classifyOrder(order({
      review_status: "PENDING_REVIEW",
      shipping_order_lines: [line({ approval_status: "PENDING_REVIEW", approved_qty: 0 })],
    }));
    expect(matchesOrderTab(dormant, "orders")).toBe(false);
    expect(matchesOrderTab(dormant, "new")).toBe(false);
  });

  it("shows a voided invoice in Cancelled even before ERP cancellation is applied", () => {
    const result = classifyOrder(order({
      cancellation_status: null,
      qbo_invoices: { raw_payload: { PrivateNote: "VOIDED" } },
    }));

    expect(result.isCancelled).toBe(true);
    expect(matchesOrderTab(result, "cancelled")).toBe(true);
    expect(matchesOrderTab(result, "orders")).toBe(false);
  });

  it("keeps historical duplicate rows hidden even if their shared QBO invoice is voided", () => {
    const result = classifyOrder(order({
      duplicate_of_order_id: "canonical-order",
      qbo_invoices: { raw_payload: { PrivateNote: "VOIDED" } },
    }));

    expect(result.isCancelled).toBe(false);
    expect(matchesOrderTab(result, "cancelled")).toBe(false);
  });
});
