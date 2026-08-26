import { describe, expect, it } from "vitest";
import { projectCanonicalCustomerQueue, type CanonicalCustomerQueueRow } from "./canonical-customer-queue";

function row(overrides: Partial<CanonicalCustomerQueueRow> = {}): CanonicalCustomerQueueRow {
  return {
    invoice: "invoice",
    orderId: "order",
    lineId: "line",
    logicalDemandKey: "line",
    openQty: 1,
    warehouseQty: 0,
    waitingQty: 1,
    inWarehouse: false,
    willCall: false,
    qty: 1,
    approvedQty: 1,
    shippedQty: 0,
    invoiceOrderedQty: null,
    provenInvoiceShippedQty: 0,
    invoiceFullyShipped: false,
    firstPaymentAt: "2026-01-01T00:00:00Z",
    invoiceDate: "2026-01-01T00:00:00Z",
    priorityDate: "2026-01-01T00:00:00Z",
    priorityDateSource: "FIRST_PAYMENT",
    orderCreatedAt: "2026-01-01T00:00:00Z",
    storedPosition: 1,
    ...overrides,
  };
}

describe("projectCanonicalCustomerQueue", () => {
  it("compacts excluded stored positions so Bernerd's active demand is #7, not stored #16", () => {
    const rows = Array.from({ length: 16 }, (_, index) => row({
      invoice: String(index + 1),
      orderId: String(index + 1),
      lineId: String(index + 1),
      logicalDemandKey: String(index + 1),
      storedPosition: index + 1,
      firstPaymentAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      excludedFromQueue: [3, 4, 6, 7, 8, 12, 13, 14, 15].includes(index + 1),
    }));

    const bernerd = projectCanonicalCustomerQueue(rows)[6];
    expect(bernerd).toMatchObject({ lineId: "16", position: "7" });
  });

  it("merges invoice demand and assigns quantity ranges after sorting by payment date", () => {
    const queue = projectCanonicalCustomerQueue([
      row({ invoice: "later", lineId: "later", logicalDemandKey: "later", firstPaymentAt: "2026-02-01T00:00:00Z", storedPosition: 12 }),
      row({ invoice: "first", lineId: "first-a", logicalDemandKey: "first-a", openQty: 1, firstPaymentAt: "2026-01-01T00:00:00Z", storedPosition: 8 }),
      row({ invoice: "first", lineId: "first-b", logicalDemandKey: "first-b", openQty: 2, firstPaymentAt: "2026-01-01T00:00:00Z", storedPosition: 9 }),
    ]);

    expect(queue.map((item) => [item.invoice, item.openQty, item.position])).toEqual([
      ["first", 3, "1-3"],
      ["later", 1, "4"],
    ]);
  });

  it("uses invoice date before order creation when first payment is not recorded", () => {
    const queue = projectCanonicalCustomerQueue([
      row({ invoice: "newer-invoice", lineId: "newer", logicalDemandKey: "newer", firstPaymentAt: null, invoiceDate: "2026-06-01", priorityDate: "2026-06-01", priorityDateSource: "INVOICE_DATE", orderCreatedAt: "2026-01-01" }),
      row({ invoice: "older-invoice", lineId: "older", logicalDemandKey: "older", firstPaymentAt: null, invoiceDate: "2026-05-01", priorityDate: "2026-05-01", priorityDateSource: "INVOICE_DATE", orderCreatedAt: "2026-07-01" }),
      row({ invoice: "paid", lineId: "paid", logicalDemandKey: "paid", firstPaymentAt: "2026-04-01", invoiceDate: "2026-06-15", priorityDate: "2026-04-01", priorityDateSource: "FIRST_PAYMENT" }),
    ]);

    expect(queue.map((item) => item.invoice)).toEqual(["paid", "older-invoice", "newer-invoice"]);
  });
});