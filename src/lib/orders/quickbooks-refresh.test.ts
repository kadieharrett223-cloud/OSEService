import { describe, expect, it } from "vitest";
import { planQuickbooksOrderRefresh, type RefreshInvoiceLine, type RefreshOrderLine } from "./quickbooks-refresh";

const aliases = new Map([["JVCJ-6", "product-jack"]]);

function invoiceLine(overrides: Partial<RefreshInvoiceLine> = {}): RefreshInvoiceLine {
  return { id: "inv-line-1", qbo_line_id: "1", product_id: "product-1", ordered_qty: 2, qbo_sku: "SKU-1", ...overrides };
}

function orderLine(overrides: Partial<RefreshOrderLine> = {}): RefreshOrderLine {
  return { id: "order-line-1", qbo_invoice_line_id: "inv-line-1", product_id: "product-1", ordered_qty: 1, approved_qty: 0, fulfilled_qty: 0, ...overrides };
}

describe("re-entering a QuickBooks invoice", () => {
  it("refreshes and approves an existing unshipped line instead of duplicating it", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine()], [orderLine()], aliases);

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toEqual([
      { lineId: "order-line-1", ordered_qty: 2, approved_qty: 2, approval_status: "APPROVED", product_id: "product-1" },
    ]);
  });

  it("never overwrites a line that has already shipped", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine({ ordered_qty: 5 })], [orderLine({ fulfilled_qty: 1, approved_qty: 1 })], aliases);

    expect(plan.updates).toHaveLength(0);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.skippedShipped).toEqual(["order-line-1"]);
  });

  it("leaves partially shipped history untouched while refreshing its siblings", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine(), invoiceLine({ id: "inv-line-2", qbo_line_id: "2", product_id: "product-2" })],
      [orderLine({ fulfilled_qty: 2 }), orderLine({ id: "order-line-2", qbo_invoice_line_id: "inv-line-2", product_id: "product-2" })],
      aliases,
    );

    expect(plan.skippedShipped).toEqual(["order-line-1"]);
    expect(plan.updates.map((update) => update.lineId)).toEqual(["order-line-2"]);
  });

  it("adds a line that exists on the invoice but not yet on the order", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine({ id: "inv-line-new", qbo_line_id: "7" })], [], aliases);

    expect(plan.updates).toHaveLength(0);
    expect(plan.inserts).toEqual([
      { qboInvoiceLineId: "inv-line-new", productId: "product-1", orderedQty: 2, qboSku: "SKU-1", qboLineId: "7" },
    ]);
  });

  it("resolves an unmapped invoice line through product aliases", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine({ id: "inv-line-3", product_id: null, qbo_sku: "jvcj-6" })], [], aliases);
    expect(plan.inserts[0]?.productId).toBe("product-jack");
  });

  it("skips an invoice line that cannot be mapped rather than inventing a product", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine({ id: "inv-line-4", product_id: null, qbo_sku: "Install" })], [], aliases);

    expect(plan.inserts).toHaveLength(0);
    expect(plan.skippedUnmapped).toEqual(["inv-line-4"]);
  });

  it("reports every product whose queue needs renumbering", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine(), invoiceLine({ id: "inv-line-2", product_id: "product-2" })],
      [orderLine()],
      aliases,
    );

    expect(plan.productIds.sort()).toEqual(["product-1", "product-2"]);
  });
});
