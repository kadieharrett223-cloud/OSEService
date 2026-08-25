import { describe, expect, it } from "vitest";
import { mergeOpenCustomerDemand } from "./customer-list-demand";

const row = (overrides = {}) => ({
  invoice: "122353",
  orderId: "f8fa9aac-a6c4-4e10-bfb5-87486e524437",
  openQty: 1,
  warehouseQty: 1,
  waitingQty: 0,
  inWarehouse: true,
  willCall: false,
  qty: 1,
  approvedQty: 1,
  shippedQty: 0,
  invoiceOrderedQty: 1,
  provenInvoiceShippedQty: 0,
  invoiceFullyShipped: false,
  ...overrides,
});

describe("final Customer List demand", () => {
  it("removes Joshua 122353 after QBO sibling shipment evidence reaches the final merge", () => {
    const finalRows = mergeOpenCustomerDemand([
      row({ provenInvoiceShippedQty: 1 }),
    ]);

    expect(finalRows).toEqual([]);
  });

  it("removes Ivan 122332 when the QBO invoice is fully shipped despite a stale different-product sibling", () => {
    const finalRows = mergeOpenCustomerDemand([
      row({ invoice: "122332", orderId: "c0606551-92ed-462e-b346-f0fe39092ee5", invoiceFullyShipped: true }),
    ]);

    expect(finalRows).toEqual([]);
  });

  it("keeps only the unshipped remainder and its active warehouse state", () => {
    const [finalRow] = mergeOpenCustomerDemand([
      row({ invoice: "partial", invoiceOrderedQty: 3, qty: 3, approvedQty: 3, openQty: 3, warehouseQty: 3, provenInvoiceShippedQty: 1 }),
    ]);

    expect(finalRow).toMatchObject({ openQty: 2, shippedQty: 1, warehouseQty: 2, waitingQty: 0, inWarehouse: true });
  });

  it("retains a normal unshipped order", () => {
    expect(mergeOpenCustomerDemand([row({ invoice: "open" })])).toHaveLength(1);
  });
});