import { describe, expect, it } from "vitest";
import { getExactInvoiceSearchTab, getOrderLifecycleLabel, getOrderSearchResultHref, searchOrders, type OrdersSearchRow } from "./orders-search";

function order(overrides: Partial<OrdersSearchRow>): OrdersSearchRow {
  const invoiceNumber = overrides.invoiceNumber ?? "126079";
  const customerName = overrides.customerName ?? "Shawn Bergquist";
  return {
    id: invoiceNumber,
    invoiceNumber,
    customerName,
    searchable: `${invoiceNumber} ${customerName}`.toLowerCase(),
    tabs: ["orders", "new"],
    ...overrides,
  };
}

describe("Orders projection search", () => {
  it("routes an exact unique archived invoice to Archived", () => {
    const orders = [order({ tabs: ["archived"] })];

    expect(getExactInvoiceSearchTab(orders, "126079")).toBe("archived");
  });

  it("routes an exact unique cancelled invoice to Cancelled", () => {
    const orders = [order({ invoiceNumber: "126080", tabs: ["cancelled"] })];

    expect(getExactInvoiceSearchTab(orders, "126080")).toBe("cancelled");
  });

  it("routes an exact unique partial invoice to Partially Shipped", () => {
    const orders = [order({ invoiceNumber: "126081", tabs: ["orders", "partial"] })];

    expect(getExactInvoiceSearchTab(orders, "126081")).toBe("partial");
  });

  it("routes an exact unique new invoice to New", () => {
    const orders = [order({ invoiceNumber: "126082", tabs: ["orders", "new"] })];

    expect(getExactInvoiceSearchTab(orders, "126082")).toBe("new");
  });

  it("keeps colliding invoice numbers separate instead of guessing a tab", () => {
    const orders = [
      order({ id: "john", invoiceNumber: "11982", customerName: "John Sweeney", searchable: "11982 john sweeney", tabs: ["archived"] }),
      order({ id: "bryant", invoiceNumber: "11982", customerName: "Bryant Bray", searchable: "11982 bryant bray", tabs: ["partial"] }),
    ];

    expect(getExactInvoiceSearchTab(orders, "11982")).toBeNull();
    expect(searchOrders(orders, "11982")).toHaveLength(2);
    expect(getOrderLifecycleLabel(orders[0])).toBe("Archived");
    expect(getOrderLifecycleLabel(orders[1])).toBe("Partially Shipped");
    expect(getOrderSearchResultHref(orders[0])).toBe("/orders/john");
    expect(getOrderSearchResultHref(orders[1])).toBe("/orders/bryant");
  });
});