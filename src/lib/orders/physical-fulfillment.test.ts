import { describe, expect, it } from "vitest";
import { getCanonicalPhysicalOrderSummary, getPhysicalFulfillmentTotals, isNonInventoryPhysicalLine, type PhysicalFulfillmentLine } from "./physical-fulfillment";
import { isRemainingPhysicalFulfillmentLine } from "./physical-fulfillment";

function line(overrides: Partial<PhysicalFulfillmentLine> = {}): PhysicalFulfillmentLine {
  return {
    product_id: "product-1",
    ordered_qty: 1,
    approved_qty: 1,
    fulfilled_qty: 0,
    fulfillment_status: "PENDING",
    products: { sku: "SKU-1", canonical_name: "Inventory item" },
    ...overrides,
  };
}

describe("physical fulfillment totals", () => {
  it("keeps every remaining mapped physical line eligible regardless of fulfillment source or assignment", () => {
    for (const fulfillmentSource of [null, "WAREHOUSE", "CONTAINER", "DROPSHIP", "OTHER"]) {
      expect(isRemainingPhysicalFulfillmentLine({
        id: `line-${fulfillmentSource ?? "unassigned"}`,
        product_id: "product-1",
        ordered_qty: 2,
        approved_qty: 2,
        fulfilled_qty: 0,
        fulfillment_status: "PENDING",
        products: { sku: "LIFT-1" },
        fulfillment_source: fulfillmentSource,
      })).toBe(true);
    }
  });

  it("excludes an already-fulfilled physical line from sibling or canonical selection", () => {
    expect(isRemainingPhysicalFulfillmentLine(line({
      id: "fulfilled-physical-line",
      approved_qty: 1,
      fulfilled_qty: 1,
      fulfillment_status: "FULFILLED",
    }))).toBe(false);
  });

  it("excludes note, service, freight, tax, and cancelled rows from physical demand", () => {
    const totals = getPhysicalFulfillmentTotals([
      line({ approved_qty: 2, fulfilled_qty: 2, fulfillment_status: "FULFILLED" }),
      line({ product_id: "note", legacy_item_code: "Note", approved_qty: 1, products: { sku: "Note" } }),
      line({ product_id: "service", legacy_item_code: "Install", approved_qty: 1 }),
      line({ product_id: "freight", legacy_item_code: "Freight", approved_qty: 1 }),
      line({ product_id: "tax", legacy_item_code: "Sales Tax", approved_qty: 1 }),
      line({ product_id: "cancelled", approved_qty: 1, fulfillment_status: "CANCELLED" }),
    ]);

    expect(totals).toEqual({ ordered: 2, fulfilled: 2, remaining: 0, lineCount: 1 });
  });

  it("caps fulfilled quantity at the physical ordered basis", () => {
    expect(getPhysicalFulfillmentTotals([
      line({ approved_qty: 1, ordered_qty: 1, fulfilled_qty: 3, fulfillment_status: "FULFILLED" }),
    ])).toEqual({ ordered: 1, fulfilled: 1, remaining: 0, lineCount: 1 });
  });

  it("detects note rows from sku, legacy code, or canonical name", () => {
    expect(isNonInventoryPhysicalLine(line({ legacy_item_code: "Note" }))).toBe(true);
    expect(isNonInventoryPhysicalLine(line({ products: { sku: "NOTE", canonical_name: "Memo" } }))).toBe(true);
    expect(isNonInventoryPhysicalLine(line({ products: { sku: "SKU-1", canonical_name: "Service call" } }))).toBe(true);
  });

  it("summarizes 12310 as 4 ordered, 3 fulfilled, 1 remaining despite orphan 4PHR row", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([
        ["AB1", 1],
        ["4PHR-9-1", 1],
        ["HPU1103", 1],
        ["HLCJ-6", 1],
      ]),
      lines: [
        line({ id: "ab1", legacy_item_code: "AB1", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "4phr", legacy_item_code: "4PHR-9-1", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "hpu", legacy_item_code: "HPU1103", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "hlcj", legacy_item_code: "HLCJ-6", approved_qty: 1, fulfilled_qty: 0 }),
        line({ id: "orphan", legacy_item_code: "4PHR-9X", approved_qty: 1, fulfilled_qty: 0 }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 4, ordered: 4, fulfilled: 3, remaining: 1, isPartiallyFulfilled: true, isComplete: false });
    expectInvariant(summary);
  });

  it("summarizes 126111 as 4 ordered, 2 fulfilled, 2 remaining", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["A", 1], ["B", 1], ["C", 1], ["D", 1]]),
      lines: [
        line({ id: "a", legacy_item_code: "A", fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "b", legacy_item_code: "B", fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "c", legacy_item_code: "C", fulfilled_qty: 0 }),
        line({ id: "d", legacy_item_code: "D", fulfilled_qty: 0 }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 4, ordered: 4, fulfilled: 2, remaining: 2, isPartiallyFulfilled: true });
    expectInvariant(summary);
  });

  it("summarizes 126163 as complete when physical lines are fulfilled and note is open", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["4PHR-9X", 2], ["HPU1103", 1], ["Note", 1]]),
      lines: [
        line({ id: "lift", legacy_item_code: "4PHR-9X", approved_qty: 2, fulfilled_qty: 2, fulfillment_status: "FULFILLED" }),
        line({ id: "hpu", legacy_item_code: "HPU1103", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "note", legacy_item_code: "Note", product_id: "note-product", approved_qty: 1, fulfilled_qty: 0 }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 2, ordered: 3, fulfilled: 3, remaining: 0, isComplete: true });
    expectInvariant(summary);
  });

  it("counts duplicate OLD_ERP/QBO representations once for 122285 Deana Bonetto", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["4PXL-10", 1], ["HPU2203", 1]]),
      lines: [
        line({ id: "qbo-lift", legacy_item_code: "4PXL-10", approved_qty: 1 }),
        line({ id: "old-lift", legacy_item_code: "4PXL-10", approved_qty: 1 }),
        line({ id: "qbo-hpu", legacy_item_code: "HPU2203", approved_qty: 1 }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 2, ordered: 2, fulfilled: 0, remaining: 2 });
    expectInvariant(summary);
  });

  it("counts duplicate representations once for 125957 Salvador Arias", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["2PBP-8", 1], ["HPU1103", 1]]),
      lines: [
        line({ id: "qbo-platform", legacy_item_code: "2PBP-8", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
        line({ id: "old-platform", legacy_item_code: "2PBP-8", approved_qty: 1, fulfilled_qty: 0 }),
        line({ id: "hpu", legacy_item_code: "HPU1103", approved_qty: 1, fulfilled_qty: 0 }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 2, ordered: 2, fulfilled: 1, remaining: 1, isPartiallyFulfilled: true });
    expectInvariant(summary);
  });

  it("ignores explicit zero-qty deleted QBO lines when computing canonical totals", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["4PXL-10B (deleted-1)", 0], ["4PXL-10B", 1]]),
      lines: [
        line({ id: "lift", legacy_item_code: "4PXL-10B", approved_qty: 1, fulfilled_qty: 0 }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 1, ordered: 1, fulfilled: 0, remaining: 1, isPartiallyFulfilled: false, isComplete: false });
    expectInvariant(summary);
  });

  it("prefers the fulfilled mapped duplicate over a stale unmapped duplicate with the same legacy SKU", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["4PTA-6", 1]]),
      lines: [
        line({ id: "stale-4pta", legacy_item_code: "4PTA-6", product_id: "old-product", approved_qty: 1, fulfilled_qty: 0, fulfillment_status: "PENDING" }),
        line({ id: "mapped-4pta", legacy_item_code: "4PTA-6", product_id: "new-product", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
      ],
    });

    expect(summary).toMatchObject({ lineCount: 1, ordered: 1, fulfilled: 1, remaining: 0, isComplete: true });
    expect(summary.items[0].line?.product_id).toBe("new-product");
    expectInvariant(summary);
  });

  it("prefers a fulfilled active sibling over the canonical parent's stale matching line", () => {
    const summary = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["URJT-45-1", 1]]),
      lines: [
        line({ id: "qbo-urjt", legacy_item_code: "URJT-45-1", approved_qty: 1, fulfilled_qty: 0, fulfillment_status: "PENDING" }),
        line({ id: "old-erp-urjt", legacy_item_code: "000182", products: { sku: "URJT-45", canonical_name: "Universal Expandable Width Rolling Jack Tray URJT-45" }, approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
      ],
    });

    expect(summary).toMatchObject({ ordered: 1, fulfilled: 1, remaining: 0, isComplete: true });
    expect(summary.items[0].line?.id).toBe("old-erp-urjt");
  });

  it("keeps same-number 11982 customer obligations separate for John Sweeney and Bryant Bray", () => {
    const john = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["Misc Charge", 1], ["Note", 1], ["Discount-1", 1]], { descriptions: { "Misc Charge": "4032-6 Three level lift", Note: "220 volt motor", "Discount-1": "-- Discount" } }),
      lines: [
        line({ id: "john-4032", legacy_item_code: "Misc Charge", product_id: "4032-6", approved_qty: 1, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
      ],
    });
    const bryant = getCanonicalPhysicalOrderSummary({
      rawPayload: invoicePayload([["2PBP-10-1 (deleted)", 1], ["UHJS-750-1 (deleted)", 2], ["2PFC-1-1 (deleted)", 1], ["Note", 1], ["Discount-1", 1]], { descriptions: { Note: "220V motor", "Discount-1": "-- Discount" } }),
      lines: [
        line({ id: "stale-4032", legacy_item_code: "4032-6", product_id: "4032-6", approved_qty: 1, fulfilled_qty: 0 }),
        line({ id: "bryant-lift", legacy_item_code: "2PBP-10", product_id: "2PBP-10", approved_qty: 1, fulfilled_qty: 0 }),
        line({ id: "bryant-stand", legacy_item_code: "UHJS-750", product_id: "UHJS-750", approved_qty: 2, fulfilled_qty: 0 }),
        line({ id: "bryant-cradle", legacy_item_code: "2PFC-1", product_id: "2PFC-1", approved_qty: 1, fulfilled_qty: 0 }),
      ],
    });

    expect(john).toMatchObject({ lineCount: 1, ordered: 1, fulfilled: 1, remaining: 0, isComplete: true });
    expect(john.items[0].line?.product_id).toBe("4032-6");
    expect(bryant).toMatchObject({ lineCount: 3, ordered: 4, fulfilled: 0, remaining: 4, isComplete: false });
    expect(bryant.items.map((item) => item.line?.product_id)).not.toContain("4032-6");
    expectInvariant(john);
    expectInvariant(bryant);
  });
});

function invoicePayload(items: Array<[string, number]>, options: { descriptions?: Record<string, string> } = {}) {
  return {
    Line: items.map(([sku, qty], index) => ({
      Id: String(index + 1),
      DetailType: "SalesItemLineDetail",
      Description: options.descriptions?.[sku] ?? (sku === "Note" ? "Please contact customer" : `Item ${sku}`),
      SalesItemLineDetail: { Qty: qty, ItemRef: { name: sku } },
    })),
  };
}

function expectInvariant(summary: ReturnType<typeof getCanonicalPhysicalOrderSummary>) {
  expect(summary.ordered).toBe(summary.fulfilled + summary.remaining);
  expect(summary.remaining).toBeGreaterThanOrEqual(0);
  expect(summary.fulfilled).toBeLessThanOrEqual(summary.ordered);
  if (summary.isPartiallyFulfilled) {
    expect(summary.fulfilled).toBeGreaterThan(0);
    expect(summary.remaining).toBeGreaterThan(0);
  }
  if (summary.isComplete) expect(summary.remaining).toBe(0);
}
