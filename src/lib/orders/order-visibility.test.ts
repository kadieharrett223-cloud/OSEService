import { describe, expect, it } from "vitest";
import { classifyOrder, matchesOrderTab, type ClassificationLine, type ClassificationOrder } from "./order-visibility";

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

  it("excludes lines whose SKU is awaiting manual mapping from operational demand", () => {
    const result = classifyOrder(
      order({ review_status: "PENDING_REVIEW", shipping_order_lines: [line({ products: { sku: "JVCJ-6" } })] }),
      { manualMappingSkus: new Set(["JVCJ-6"]) },
    );

    expect(result.operationalLines).toHaveLength(0);
    expect(result.isVisibleOperationalOrder).toBe(false);
  });

  it("maps classifications onto the correct tabs", () => {
    const active = classifyOrder(order());
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
});
