import { describe, expect, it } from "vitest";
import { projectCanonicalCustomerQueue, projectCanonicalCustomerQueuesByProductKey, type CanonicalCustomerQueueRow } from "./canonical-customer-queue";

function row(overrides: Partial<CanonicalCustomerQueueRow> = {}): CanonicalCustomerQueueRow {
  return {
    invoice: "invoice",
    orderId: "order",
    sourceInvoiceId: "source-invoice",
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
      sourceInvoiceId: `source-${index + 1}`,
      lineId: String(index + 1),
      logicalDemandKey: String(index + 1),
      storedPosition: index + 1,
      firstPaymentAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      excludedFromQueue: [3, 4, 6, 7, 8, 12, 13, 14, 15].includes(index + 1),
    }));

    const bernerd = projectCanonicalCustomerQueue(rows)[6];
    expect(bernerd).toMatchObject({ lineId: "16", position: "7" });
  });

  it("merges source-invoice demand and assigns quantity ranges after sorting by payment date", () => {
    const queue = projectCanonicalCustomerQueue([
      row({ invoice: "later", sourceInvoiceId: "later-source", lineId: "later", logicalDemandKey: "later", firstPaymentAt: "2026-02-01T00:00:00Z", storedPosition: 12 }),
      row({ invoice: "first", sourceInvoiceId: "first-source", lineId: "first-a", logicalDemandKey: "first-a", openQty: 1, firstPaymentAt: "2026-01-01T00:00:00Z", storedPosition: 8 }),
      row({ invoice: "first", sourceInvoiceId: "first-source", lineId: "first-b", logicalDemandKey: "first-b", openQty: 2, firstPaymentAt: "2026-01-01T00:00:00Z", storedPosition: 9 }),
    ]);

    expect(queue.map((item) => [item.invoice, item.openQty, item.position])).toEqual([
      ["first", 3, "1-3"],
      ["later", 1, "4"],
    ]);
  });

  it("uses invoice creation date when first payment is not recorded", () => {
    const queue = projectCanonicalCustomerQueue([
      row({ invoice: "122347", sourceInvoiceId: "newer-source", lineId: "newer", logicalDemandKey: "newer", firstPaymentAt: null, invoiceDate: "2026-06-01", priorityDate: "2026-06-01", priorityDateSource: "INVOICE_DATE", orderCreatedAt: "2026-01-01" }),
      row({ invoice: "127011", sourceInvoiceId: "older-source", lineId: "older", logicalDemandKey: "older", firstPaymentAt: null, invoiceDate: "2026-05-01", priorityDate: "2026-05-01", priorityDateSource: "INVOICE_DATE", orderCreatedAt: "2026-07-01" }),
      row({ invoice: "paid", sourceInvoiceId: "paid-source", lineId: "paid", logicalDemandKey: "paid", firstPaymentAt: "2026-04-01", invoiceDate: "2026-06-15", priorityDate: "2026-04-01", priorityDateSource: "FIRST_PAYMENT" }),
    ]);

    expect(queue.map((item) => item.invoice)).toEqual(["paid", "127011", "122347"]);
  });

  it("uses the invoice number only when payment and creation dates are both unavailable", () => {
    const queue = projectCanonicalCustomerQueue([
      row({ invoice: "127011", sourceInvoiceId: "newer-source", lineId: "newer", logicalDemandKey: "newer", firstPaymentAt: null, invoiceDate: null, priorityDate: null, priorityDateSource: "INVOICE_NUMBER" }),
      row({ invoice: "122347", sourceInvoiceId: "older-source", lineId: "older", logicalDemandKey: "older", firstPaymentAt: null, invoiceDate: null, priorityDate: null, priorityDateSource: "INVOICE_NUMBER" }),
    ]);

    expect(queue.map((item) => item.invoice)).toEqual(["122347", "127011"]);
  });

  it("assigns separate positions to distinct invoices with the same printed number", () => {
    const queue = projectCanonicalCustomerQueue([
      row({ invoice: "122347", sourceInvoiceId: "qbo-38527", orderId: "jeffrey", lineId: "jeffrey-line", logicalDemandKey: "jeffrey-line", firstPaymentAt: "2026-01-01T00:00:00Z" }),
      row({ invoice: "122347", sourceInvoiceId: "qbo-38526", orderId: "kevin", lineId: "kevin-line", logicalDemandKey: "kevin-line", firstPaymentAt: "2026-01-02T00:00:00Z" }),
    ]);

    expect(queue.map((item) => [item.orderId, item.position])).toEqual([["jeffrey", "1"], ["kevin", "2"]]);
  });

  it("shares one sequence between recycled and active product records with the same operational SKU", () => {
    const productKeyByLineId = new Map([
      ["jonathan-line", "4PML9"],
      ["jeffrey-line", "4PML9"],
    ]);
    const queue = projectCanonicalCustomerQueuesByProductKey([
      row({ invoice: "12002", orderId: "jonathan", sourceInvoiceId: "jonathan-source", lineId: "jonathan-line", logicalDemandKey: "jonathan-line", firstPaymentAt: "2026-02-11T00:00:00Z" }),
      row({ invoice: "122347", orderId: "jeffrey", sourceInvoiceId: "jeffrey-source", lineId: "jeffrey-line", logicalDemandKey: "jeffrey-line", firstPaymentAt: "2026-07-30T00:00:00Z" }),
    ], (item) => productKeyByLineId.get(item.lineId) ?? item.lineId);

    expect(queue.map((item) => [item.orderId, item.position])).toEqual([["jonathan", "1"], ["jeffrey", "2"]]);
  });
});