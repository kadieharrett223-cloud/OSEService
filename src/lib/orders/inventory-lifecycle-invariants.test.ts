import { describe, expect, it } from "vitest";
import { getCanonicalOpenDemandLines, openQtyOf } from "@/lib/demand/product-demand";
import { resolveProductCoverage, type OpenQueueLine, type ProductContainerSupply } from "@/lib/fulfillment/suggested-allocation";
import { shouldMoveWarehouseInventory } from "./fulfillment-source";
import { matchesPhysicalLineToInvoiceSku } from "./physical-fulfillment";

const productId = "4pxl-10";

function demandLine(overrides: Record<string, unknown> = {}) {
  return {
    id: "line",
    product_id: productId,
    approved_qty: 1,
    fulfilled_qty: 0,
    approval_status: "APPROVED",
    fulfillment_status: "PENDING",
    ...overrides,
  };
}

function queueLine(id: string, remainingQty: number, position: number): OpenQueueLine {
  return {
    id,
    product_id: productId,
    remaining_qty: remainingQty,
    priority: "NORMAL",
    queue_position_start: position,
    approved_at: "2026-08-01T00:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    has_live_allocation: false,
  };
}

function incomingSupply(quantity: number): ProductContainerSupply {
  return {
    container_id: "container-238",
    container_number: "238",
    available_qty: quantity,
    eta_confirmed_date: "2026-08-23",
    eta_estimated_date: null,
    entered_date: "2026-04-23T21:26:50.458Z",
  };
}

function availableNow(onFloor: number, sold: number) {
  return Math.max(0, onFloor - sold);
}

describe("4PXL-10 inventory lifecycle invariants", () => {
  it("counts a current physical obligation exactly once across OLD_ERP and QBO representations", () => {
    const lines = getCanonicalOpenDemandLines([
      demandLine({ id: "old-erp", logical_demand_key: "qbo-line-1" }),
      demandLine({ id: "qbo", qbo_invoice_line_id: "qbo-line-1" }),
    ], new Set(), new Set());

    expect(lines).toHaveLength(1);
    expect(lines.reduce((sum, line) => sum + openQtyOf(line), 0)).toBe(1);
  });

  it("keeps unfulfilled demand sold while it waits for Incoming stock without changing ON_FLOOR", () => {
    const coverage = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 0]]),
      queueLinesByProduct: new Map([[productId, [queueLine("open-order", 1, 1)]]]),
      containerSupplyByProduct: new Map([[productId, [incomingSupply(1)]]]),
    });

    expect(coverage.lines.get("open-order")?.incomingQty).toBe(1);
    expect(coverage.lines.get("open-order")?.warehouseQty).toBe(0);
    expect(availableNow(0, 1)).toBe(0);
  });

  it("moves received supply from Incoming coverage to warehouse coverage exactly once", () => {
    const beforeReceipt = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 0]]),
      queueLinesByProduct: new Map([[productId, [queueLine("open-order", 1, 1)]]]),
      containerSupplyByProduct: new Map([[productId, [incomingSupply(1)]]]),
    });
    const afterReceipt = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 1]]),
      queueLinesByProduct: new Map([[productId, [queueLine("open-order", 1, 1)]]]),
      containerSupplyByProduct: new Map([[productId, []]]),
    });

    expect(beforeReceipt.lines.get("open-order")?.incomingQty).toBe(1);
    expect(afterReceipt.lines.get("open-order")?.warehouseQty).toBe(1);
    expect(afterReceipt.lines.get("open-order")?.incomingQty).toBe(0);
  });

  it("removes a shipped warehouse obligation from Sold while decrementing ON_FLOOR once", () => {
    const openBeforeShipment = getCanonicalOpenDemandLines([
      demandLine({ id: "old-erp", logical_demand_key: "qbo-line-1", warehouse_status: "IN_WAREHOUSE" }),
      demandLine({ id: "qbo", qbo_invoice_line_id: "qbo-line-1", warehouse_status: "IN_WAREHOUSE" }),
    ], new Set(), new Set());
    const openAfterShipment = getCanonicalOpenDemandLines([
      demandLine({ id: "old-erp", logical_demand_key: "qbo-line-1", warehouse_status: "IN_WAREHOUSE" }),
      demandLine({ id: "qbo", qbo_invoice_line_id: "qbo-line-1", fulfilled_qty: 1, fulfillment_status: "FULFILLED", warehouse_status: "FULFILLED" }),
    ], new Set(["qbo-line-1"]), new Set());

    expect(openBeforeShipment.reduce((sum, line) => sum + openQtyOf(line), 0)).toBe(1);
    expect(openAfterShipment).toHaveLength(0);
    expect(shouldMoveWarehouseInventory("WAREHOUSE")).toBe(true);
    expect(availableNow(26, 11)).toBe(15);
    expect(availableNow(25, 10)).toBe(15);
  });

  it("closes 122332's 4PXL-10 obligation only when explicit replacement evidence marks it superseded", () => {
    const open = getCanonicalOpenDemandLines([
      demandLine({ id: "122332-old-erp-4pxl-10", source_record_id: "122332-old-erp", fulfillment_status: "REPLACED" }),
      demandLine({ id: "122332-qbo-4pxl-10b", qbo_invoice_line_id: "122332-qbo-4pxl-10b", fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
    ], new Set(["122332-qbo-4pxl-10b"]), new Set());

    expect(open).toHaveLength(0);
  });

  it("does not match 4PXL-10 physical lines to a distinct 4PXL-10B QBO item", () => {
    expect(matchesPhysicalLineToInvoiceSku(
      { id: "122332-old-erp-4pxl-10", legacy_item_code: "4PXL-10" },
      "4PXL-10B",
    )).toBe(false);
  });

  it.each(["122345", "122350", "122353", "125986", "127012"])("does not resurrect the shipped %s 4PXL-10 sibling", (invoice) => {
    const logicalQboLineId = `${invoice}-qbo-4pxl-10`;
    const open = getCanonicalOpenDemandLines([
      demandLine({ id: `${invoice}-old`, logical_demand_key: logicalQboLineId }),
      demandLine({ id: `${invoice}-qbo`, qbo_invoice_line_id: logicalQboLineId, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
    ], new Set([logicalQboLineId]), new Set());

    expect(open).toHaveLength(0);
  });

  it.each(["12288", "12300"])("keeps fulfilled %s control at zero Sold", (invoice) => {
    const open = getCanonicalOpenDemandLines([
      demandLine({ id: `${invoice}-4pxl-10`, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }),
    ], new Set(), new Set());

    expect(open).toHaveLength(0);
  });

  it("keeps only the unshipped remainder sold after a partial warehouse fulfillment", () => {
    const open = getCanonicalOpenDemandLines([
      demandLine({ id: "old-erp", logical_demand_key: "qbo-line-1", approved_qty: 3 }),
      demandLine({ id: "qbo", qbo_invoice_line_id: "qbo-line-1", approved_qty: 3, fulfilled_qty: 1, fulfillment_status: "PARTIALLY_FULFILLED" }),
    ], new Set(), new Set());

    expect(open).toHaveLength(1);
    expect(openQtyOf(open[0]!)).toBe(2);
    expect(availableNow(4, 3)).toBe(1);
    expect(availableNow(3, 2)).toBe(1);
  });

  it("closes cancelled demand without decrementing ON_FLOOR or retaining Incoming coverage", () => {
    const open = getCanonicalOpenDemandLines([
      demandLine({ parent_cancellation_status: "CANCELLED" }),
    ], new Set(), new Set());

    expect(open).toHaveLength(0);
    expect(shouldMoveWarehouseInventory("DROPSHIP")).toBe(false);
    expect(availableNow(26, 11)).toBe(15);
    expect(availableNow(26, 10)).toBe(16);
  });
});