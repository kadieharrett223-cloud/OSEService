import { describe, expect, it } from "vitest";
import { incrementalPaymentStartDate, selectPaymentLinkedInvoiceRefreshIds } from "./integration";

describe("payment-linked QBO invoice refresh", () => {
  it("refreshes a paid invoice that is missing from the local snapshot", () => {
    const refreshIds = selectPaymentLinkedInvoiceRefreshIds(
      new Map([["127152", "2026-09-16"]]),
      [],
    );

    expect(refreshIds).toEqual(["127152"]);
  });

  it("refreshes a locally unpaid invoice after a QBO payment, but not a current paid snapshot", () => {
    const refreshIds = selectPaymentLinkedInvoiceRefreshIds(
      new Map([
        ["newly-paid", "2026-09-16"],
        ["already-paid", "2026-09-15"],
        ["partially-paid", "2026-09-14"],
      ]),
      [
        { qbo_invoice_id: "newly-paid", payment_status: "Unpaid" },
        { qbo_invoice_id: "already-paid", payment_status: "Paid" },
        { qbo_invoice_id: "partially-paid", payment_status: "Partially Paid" },
      ],
    );

    expect(refreshIds).toEqual(["newly-paid"]);
  });
});

describe("incremental QBO payment scans", () => {
  it("keeps a short overlap after the last completed sync", () => {
    expect(incrementalPaymentStartDate("2026-09-21T12:00:00.000Z")).toBe("2026-09-18");
  });

  it("uses a full payment scan until there has been a completed sync", () => {
    expect(incrementalPaymentStartDate(null)).toBeUndefined();
    expect(incrementalPaymentStartDate("not-a-date")).toBeUndefined();
  });
});
