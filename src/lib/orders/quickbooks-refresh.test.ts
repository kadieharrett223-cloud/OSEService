import { describe, expect, it } from "vitest";
import { getCanonicalOpenDemandLines, isOpenCustomerQueueLine } from "@/lib/demand/product-demand";
import { planQuickbooksOrderRefresh, qboSkuCandidates, resolveInvoiceOrder, resolveKnownQboProductId, type RefreshInvoiceLine, type RefreshOrderLine } from "./quickbooks-refresh";

const aliases = new Map([["JVCJ-6", "product-jack"]]);

function invoiceLine(overrides: Partial<RefreshInvoiceLine> = {}): RefreshInvoiceLine {
  return { id: "inv-line-1", qbo_line_id: "1", product_id: "product-1", ordered_qty: 2, qbo_sku: "SKU-1", ...overrides };
}

function orderLine(overrides: Partial<RefreshOrderLine> = {}): RefreshOrderLine {
  return { id: "order-line-1", qbo_invoice_line_id: "inv-line-1", product_id: "product-1", ordered_qty: 1, approved_qty: 0, fulfilled_qty: 0, ...overrides };
}

describe("re-entering a QuickBooks invoice", () => {
  it("approves only an exact known alias after a QBO item identity change", () => {
    expect(resolveKnownQboProductId("4PML-9-1", new Map([["4PML-9", "product-lift"]]), "old-product", true)).toBe("product-lift");
    expect(resolveKnownQboProductId("UNKNOWN-DELETED", new Map([["4PML-9", "product-lift"]]), "old-product", true)).toBeNull();
  });

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

  it("ignores mapped physical QBO lines that import with zero quantity", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "inv-line-zero", qbo_line_id: "9", product_id: null, ordered_qty: 0, qbo_sku: "2PCFHD-12 (deleted-1)" })],
      [],
      new Map([["2PCFHD-12", "product-lift"]]),
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.skippedShipped).toHaveLength(0);
    expect(plan.skippedUnmapped).toHaveLength(0);
  });

  it("resolves an unmapped invoice line through product aliases", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine({ id: "inv-line-3", product_id: null, qbo_sku: "jvcj-6" })], [], aliases);
    expect(plan.inserts[0]?.productId).toBe("product-jack");
  });

  it("maps a deleted QBO SKU variant to its live alias", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "inv-line-deleted", product_id: null, qbo_sku: "4PXL-10-1 (deleted)" })],
      [],
      new Map([["4PXL-10", "product-lift"]]),
    );

    expect(qboSkuCandidates("4PXL-10-1 (deleted)")).toEqual(["4PXL-10-1 (DELETED)", "4PXL-10-1", "4PXL-10"]);
    expect(plan.inserts[0]?.productId).toBe("product-lift");
  });

  it("maps a QBO duplicate-suffix SKU to its base operational alias", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "inv-line-suffix", product_id: null, qbo_sku: "4PML-9-1" })],
      [],
      new Map([["4PML-9", "product-lift"]]),
    );

    expect(qboSkuCandidates("4PML-9-1")).toEqual(["4PML-9-1", "4PML-9"]);
    expect(plan.inserts[0]?.productId).toBe("product-lift");
  });

  it("maps a deleted packaged SKU variant to its exact operational component", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "inv-line-package", product_id: null, qbo_sku: "HPU1103-PKG-1 (deleted)" })],
      [],
      new Map([["HPU1103", "product-motor"]]),
    );

    expect(qboSkuCandidates("HPU1103-PKG-1 (deleted)")).toEqual([
      "HPU1103-PKG-1 (DELETED)",
      "HPU1103-PKG-1",
      "HPU1103-PKG",
      "HPU1103",
    ]);
    expect(plan.inserts[0]?.productId).toBe("product-motor");
  });

  it.each(["HPU1103-PKG (deleted)", "HPU1103-PKG-1 (deleted)", "HPU2203-PKG (deleted)", "HPU2203-PKG-1 (deleted)", "HPU2204-PKG (deleted)"])("keeps the exact motor identity for %s", (sku) => {
    const baseSku = sku.replace(/\s*\(deleted\)$/i, "").replace(/-1$/, "").replace(/-PKG$/, "");
    expect(qboSkuCandidates(sku)).toContain(baseSku);
  });

  it("maps a deleted QBO SKU with multiple suffixes without stripping the base capacity", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "inv-line-double-deleted", product_id: null, qbo_sku: "4PHDXL-12-1-1 (deleted)" })],
      [],
      new Map([["4PHDXL-12", "product-heavy-lift"]]),
    );

    expect(qboSkuCandidates("4PHDXL-12-1-1 (deleted)")).toEqual([
      "4PHDXL-12-1-1 (DELETED)",
      "4PHDXL-12-1-1",
      "4PHDXL-12-1",
      "4PHDXL-12",
    ]);
    expect(plan.inserts[0]?.productId).toBe("product-heavy-lift");
  });

  it("skips an invoice line that cannot be mapped rather than inventing a product", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine({ id: "inv-line-4", product_id: null, qbo_sku: "Install" })], [], aliases);

    expect(plan.inserts).toHaveLength(0);
    expect(plan.skippedUnmapped).toEqual([]);
  });

  it("always treats discount item-name lines as non-inventory", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "discount-line", product_id: null, qbo_sku: "Discount-1", source_description: "swap meet 10%" })],
      [],
      new Map([["DISCOUNT-1", "product-discount"]]),
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.skippedUnmapped).toHaveLength(0);
  });

  it("keeps an existing mapped line active when QBO temporarily omits its mapping", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ product_id: null, qbo_sku: "UNMAPPED-TEMPORARILY" })],
      [orderLine({ product_id: "product-existing", approved_qty: 1 })],
      new Map(),
    );

    expect(plan.removals).toEqual([]);
    expect(plan.skippedUnmapped).toEqual([]);
    expect(plan.updates).toEqual([
      { lineId: "order-line-1", ordered_qty: 2, approved_qty: 2, approval_status: "APPROVED", product_id: "product-existing" },
    ]);
    expect(plan.productIds).toEqual(["product-existing"]);
  });

  it("leaves an existing unmapped line for mapping review instead of deleting it", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ product_id: null, qbo_sku: "UNMAPPED-TEMPORARILY" })],
      [orderLine({ product_id: null })],
      new Map(),
    );

    expect(plan.removals).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.skippedUnmapped).toEqual(["inv-line-1"]);
  });

  it("treats an inspection invoice line as service rather than shippable inventory", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "inspection-line", product_id: null, qbo_sku: "inspection", source_description: "Measure the site and verify the concrete." })],
      [],
      aliases,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.skippedUnmapped).toHaveLength(0);
  });

  it("allows mapped misc charge lines to refresh as physical demand", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ id: "misc-line", qbo_sku: "Misc Charge", source_description: "4032-6 Three level lift", product_id: "product-lift" })],
      [],
      aliases,
    );

    expect(plan.inserts).toEqual([
      { qboInvoiceLineId: "misc-line", productId: "product-lift", orderedQty: 2, qboSku: "Misc Charge", qboLineId: "1" },
    ]);
  });

  it("reports every product whose queue needs renumbering", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine(), invoiceLine({ id: "inv-line-2", product_id: "product-2" })],
      [orderLine()],
      aliases,
    );

    expect(plan.productIds.sort()).toEqual(["product-1", "product-2"]);
  });

  // Case 6: entering an invoice that already exists must reuse it.
  it("reuses the existing order instead of creating a duplicate", () => {
    expect(resolveInvoiceOrder({ id: "order-1" })).toEqual({ action: "refresh", orderId: "order-1" });
  });

  it("only creates an order when the invoice has never been entered", () => {
    expect(resolveInvoiceOrder(null)).toEqual({ action: "create" });
    expect(resolveInvoiceOrder(undefined)).toEqual({ action: "create" });
  });

  // Case 7: a refresh carries current QuickBooks data, never newer ERP operational state.
  it("never writes warehouse, fulfilment or shipped quantity fields", () => {
    const plan = planQuickbooksOrderRefresh([invoiceLine()], [orderLine()], aliases);

    for (const update of plan.updates) {
      expect(Object.keys(update).sort()).toEqual(["approval_status", "approved_qty", "lineId", "ordered_qty", "product_id"]);
      expect(update).not.toHaveProperty("warehouse_status");
      expect(update).not.toHaveProperty("fulfillment_status");
      expect(update).not.toHaveProperty("fulfilled_qty");
    }
  });

  it("does not reactivate demand that was already fulfilled", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ ordered_qty: 3 })],
      [orderLine({ approved_qty: 3, fulfilled_qty: 3 })],
      aliases,
    );

    expect(plan.updates).toHaveLength(0);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.skippedShipped).toEqual(["order-line-1"]);
  });

  it("uses the current QBO-line mapping as the authority", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ product_id: "product-different" })],
      [orderLine({ product_id: "product-existing" })],
      aliases,
    );

    expect(plan.updates[0]?.product_id).toBe("product-different");
  });

  it("replaces the operational product when the refreshed QBO line maps to a different item", () => {
    const plan = planQuickbooksOrderRefresh(
      [invoiceLine({ product_id: "product-yzrcj" })],
      [orderLine({ product_id: "product-jvcj" })],
      aliases,
    );

    expect(plan.updates[0]?.product_id).toBe("product-yzrcj");
    expect(plan.productIds.sort()).toEqual(["product-jvcj", "product-yzrcj"]);
  });

  it("keeps every unchanged product queued while replacing one product on a refreshed invoice", () => {
    const currentInvoiceLines = [
      invoiceLine({ id: "qbo-hdmbl", qbo_line_id: "1", product_id: "product-hdmbl", qbo_sku: "HDMBL-10", ordered_qty: 1 }),
      invoiceLine({ id: "qbo-jack", qbo_line_id: "2", product_id: "product-jvcj", qbo_sku: "JVCJ-6", ordered_qty: 1 }),
      invoiceLine({ id: "qbo-hpu", qbo_line_id: "3", product_id: "product-hpu", qbo_sku: "HPU1103", ordered_qty: 1 }),
    ];
    const currentOrderLines = [
      orderLine({ id: "line-hdmbl", qbo_invoice_line_id: "qbo-hdmbl", product_id: "product-hdmbl", ordered_qty: 1, approved_qty: 1 }),
      orderLine({ id: "line-jack", qbo_invoice_line_id: "qbo-jack", product_id: "product-yzrcj", ordered_qty: 1, approved_qty: 1 }),
      orderLine({ id: "line-hpu", qbo_invoice_line_id: "qbo-hpu", product_id: "product-hpu", ordered_qty: 1, approved_qty: 1 }),
    ];

    const plan = planQuickbooksOrderRefresh(currentInvoiceLines, currentOrderLines, new Map());
    expect(plan.removals).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates.map((update) => [update.lineId, update.product_id])).toEqual([
      ["line-hdmbl", "product-hdmbl"],
      ["line-jack", "product-jvcj"],
      ["line-hpu", "product-hpu"],
    ]);
    expect(new Set(plan.productIds)).toEqual(new Set(["product-hdmbl", "product-yzrcj", "product-jvcj", "product-hpu"]));

    const refreshedLines = currentOrderLines.map((line) => {
      const update = plan.updates.find((candidate) => candidate.lineId === line.id)!;
      return {
        ...line,
        ...update,
        approval_status: "APPROVED",
        fulfillment_status: "PENDING",
        parent_source_type: "QBO_INVOICE",
      };
    });
    const retiredHistory = [
      { ...refreshedLines[0], id: "retired-hdmbl", qbo_invoice_line_id: null, logical_demand_key: "qbo-hdmbl", fulfilled_qty: 1, fulfillment_status: "FULFILLED", parent_duplicate_of_order_id: "live-order" },
      { ...refreshedLines[2], id: "retired-hpu", qbo_invoice_line_id: null, logical_demand_key: "qbo-hpu", fulfilled_qty: 1, fulfillment_status: "FULFILLED", parent_duplicate_of_order_id: "live-order" },
    ];
    const staleHistoricalResolutions = [
      { qbo_invoice_line_id: "qbo-hdmbl", resolution_type: "HISTORICAL_FULFILLMENT" as const, status: "ACTIVE" as const },
      { qbo_invoice_line_id: "qbo-hpu", resolution_type: "DUPLICATE" as const, status: "ACTIVE" as const },
    ];
    const queueLines = getCanonicalOpenDemandLines(
      [...refreshedLines, ...retiredHistory],
      new Set(),
      new Set(),
      staleHistoricalResolutions,
    );

    expect(queueLines).toHaveLength(3);
    expect(queueLines.every(isOpenCustomerQueueLine)).toBe(true);
    expect(queueLines.map((line) => line.product_id)).toEqual(["product-hdmbl", "product-jvcj", "product-hpu"]);
  });

  it("removes unshipped demand that no longer exists on the current QBO invoice", () => {
    const plan = planQuickbooksOrderRefresh([], [orderLine({ product_id: "product-old" })], aliases);

    expect(plan.removals).toEqual([{ lineId: "order-line-1", productId: "product-old" }]);
    expect(plan.productIds).toEqual(["product-old"]);
  });

  it("preserves shipped history even when its QBO line is no longer current", () => {
    const plan = planQuickbooksOrderRefresh([], [orderLine({ fulfilled_qty: 1 })], aliases);

    expect(plan.removals).toHaveLength(0);
    expect(plan.skippedShipped).toEqual(["order-line-1"]);
  });
});
